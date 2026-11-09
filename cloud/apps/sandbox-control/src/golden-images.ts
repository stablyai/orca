// Golden images the Worker keeps fresh by itself, one step per cron tick:
// - refresh: before the active image expires, clone it into a new snapshot (no source build needed);
// - release: when GOLDEN_IMAGE_SOURCE names an Orca release with an orca-server tarball, build from it;
// - source: when GOLDEN_IMAGE_SOURCE is `git:<repo>#<branch>`, rebuild orcad from that branch's HEAD
//   whenever HEAD changes code that ships in the VM (golden-source.ts). The commit is the image's
//   `bundle_sha256` (`git:<sha>`) and /opt/orca/runtime/orcad/SOURCE_COMMIT.
// Clone refreshes keep `bundle_sha256`, so a refreshed image still knows which commit it carries.
// A new image becomes active only after a smoke boot reaches orcad ready; the previous one is kept
// (`retired`, still bootable) until the next rotation succeeds, so a bad build never strands creates.
import { MANIFEST, PROVISION_SCRIPT, SOURCE_BUILD_SCRIPT, VM_SCRIPT_SOURCES } from '../image/vm-scripts.generated'
import { VM_SCRIPTS, provisionEnv, resolveReleaseBundle, utf8Base64, type GoldenImageManifest } from '../image/golden-image'
import { parseGitSource, resolveSourceHead, type AppRequest, type GitSource, type SourceHead } from './golden-source'
import type { GoldenImageProviderApi } from './golden-image-provider'
import { compileNetworkPolicy } from './network-policy'
import type { SandboxProviderApi } from './sandbox-provider'
import { ORCAD_PORT, startOrcad } from './sandbox-vm-commands'

export type GoldenImageDeps = {
  db: D1Database
  provider: SandboxProviderApi & GoldenImageProviderApi
  now: () => number
  config: {
    environment: string
    region: string
    /** Snapshot TTL for new images; 0 keeps them until rotated out. */
    expirationMs: number
    /** `release:latest`, `release:v1.2.3` or `git:https://github.com/<owner>/<repo>#<branch>`; unset = refresh-only. */
    source?: string
    /** GitHub App requests (git sources read the repo through its installation). */
    github?: AppRequest
    /** Fallback when no row is active yet (wrangler var); adopted as the first active row. */
    seedSnapshotId?: string
    /** Refresh this long before the active image expires (default 24 h). */
    refreshBeforeMs?: number
    fetch?: typeof fetch
  }
}

type GoldenRow = {
  id: string
  source: string
  bundle_sha256: string | null
  status: 'building' | 'smoking' | 'active' | 'retired' | 'failed' | 'deleted'
  build_name: string | null
  session_id: string | null
  command_id: string | null
  snapshot_id: string | null
  expires_at: number | null
  error: string | null
  created_at: number
  updated_at: number
  activated_at: number | null
}

const REFRESH_BEFORE_MS = 24 * 60 * 60_000
const BUILD_DEADLINE_MS = 45 * 60_000
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000
const WIPE = '/opt/orca/bin/orca-image-wipe'

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `gld_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** The image new sandboxes boot from: the active row, else the configured seed. */
export async function currentGoldenSnapshotId(db: D1Database, seed?: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT snapshot_id FROM golden_images WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1`)
    .first<{ snapshot_id: string }>()
  return row?.snapshot_id ?? seed ?? null
}

async function rows(db: D1Database, statuses: GoldenRow['status'][]): Promise<GoldenRow[]> {
  const marks = statuses.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT * FROM golden_images WHERE status IN (${marks}) ORDER BY created_at DESC`)
    .bind(...statuses)
    .all<GoldenRow>()
  return results
}

async function update(db: D1Database, id: string, patch: Partial<GoldenRow>, now: number): Promise<void> {
  const entries = Object.entries(patch)
  await db
    .prepare(`UPDATE golden_images SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), now, id)
    .run()
}

async function insert(db: D1Database, row: Pick<GoldenRow, 'id' | 'source' | 'status'> & Partial<GoldenRow>, now: number) {
  await db
    .prepare(
      `INSERT INTO golden_images (id, source, bundle_sha256, status, build_name, session_id, command_id, snapshot_id,
         expires_at, created_at, updated_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.source, row.bundle_sha256 ?? null, row.status, row.build_name ?? null, row.session_id ?? null,
      row.command_id ?? null, row.snapshot_id ?? null, row.expires_at ?? null, now, now, row.activated_at ?? null)
    .run()
}

export type GoldenTick =
  | 'idle'
  | 'seeded'
  | 'refresh-started'
  | 'release-started'
  | 'building'
  | 'built'
  | 'activated'
  | 'failed'
  | 'release-unavailable'
  | 'source-started'
  | 'source-unavailable'

/** One step of the rotation state machine; safe to call every cron tick. */
export async function advanceGoldenImages(deps: GoldenImageDeps): Promise<GoldenTick> {
  const { db, provider } = deps
  const now = deps.now()
  const [inFlight] = await rows(db, ['building', 'smoking'])
  if (inFlight?.status === 'building') {
    return stepBuild(deps, inFlight)
  }
  if (inFlight?.status === 'smoking') {
    return stepSmoke(deps, inFlight)
  }
  let [active] = await rows(db, ['active'])
  if (!active && deps.config.seedSnapshotId) {
    const snapshot = await provider.getSnapshot(deps.config.seedSnapshotId)
    await insert(db, {
      id: randomId(),
      source: 'seed',
      status: 'active',
      snapshot_id: deps.config.seedSnapshotId,
      expires_at: snapshot?.expiresAt ?? null,
      activated_at: now
    }, now)
    ;[active] = await rows(db, ['active'])
    if (!active) {
      return 'idle'
    }
    return 'seeded'
  }
  if (!active?.snapshot_id) {
    return 'idle'
  }
  const recentFailure = (await rows(db, ['failed'])).find((r) => now - r.updated_at < RETRY_AFTER_FAILURE_MS)
  const release = deps.config.source?.startsWith('release:') ? await desiredRelease(deps) : null
  if (release === 'unavailable') {
    // No orca-server tarball on that release yet; keep refreshing the current image meanwhile.
  } else if (release && release.sha256 !== active.bundle_sha256 && recentFailure?.bundle_sha256 !== release.sha256) {
    return startRelease(deps, release)
  }
  const git = parseGitSource(deps.config.source)
  let sourceUnavailable = false
  if (git) {
    const activeSha = active.bundle_sha256?.startsWith('git:') ? active.bundle_sha256.slice('git:'.length) : null
    const head = deps.config.github
      ? await resolveSourceHead(deps.config.github, git, activeSha, deps.config.fetch).catch(() => null)
      : null
    sourceUnavailable = head === null
    if (head && head.touchesVm && head.sha !== activeSha && recentFailure?.bundle_sha256 !== `git:${head.sha}`) {
      return startSourceBuild(deps, git, head)
    }
  }
  const refreshBefore = deps.config.refreshBeforeMs ?? REFRESH_BEFORE_MS
  if (active.expires_at !== null && active.expires_at - now < refreshBefore && !recentFailure) {
    return startRefresh(deps, active)
  }
  return release === 'unavailable' ? 'release-unavailable' : sourceUnavailable ? 'source-unavailable' : 'idle'
}

/** Build sandbox: fetch the commit, build orcad + CLI, provision; stepBuild then wipes, snapshots, smokes. */
async function startSourceBuild(deps: GoldenImageDeps, git: GitSource, head: SourceHead): Promise<GoldenTick> {
  const { db, provider } = deps
  const now = deps.now()
  const id = randomId()
  const name = `orca-${deps.config.environment}-golden-${id}`
  await insert(db, { id, source: `git:${git.repoUrl}#${git.ref}`, bundle_sha256: `git:${head.sha}`, status: 'building', build_name: name }, now)
  try {
    const box = await provider.createBuildSandbox({
      name,
      image: MANIFEST.image,
      // A source build (pnpm install + orcad + CLI) is CPU-bound: the widest box Pro allows.
      vcpus: 8,
      region: deps.config.region,
      timeoutMs: BUILD_DEADLINE_MS,
      tags: { orcaGoldenImage: id, orcaEnv: deps.config.environment }
    })
    const env = {
      ...provisionEnv({ manifest: MANIFEST, provisionScript: PROVISION_SCRIPT, vmScripts: VM_SCRIPT_SOURCES, buildId: id }),
      ORCA_SRC_REPO: git.repoUrl,
      ORCA_SRC_SHA: head.sha,
      // 1 h, read-only, this repo only; the script uses it for one fetch and unsets it.
      ORCA_SRC_AUTH: `Authorization: ${head.gitAuthorization}`,
      ORCA_PROVISION_SCRIPT: utf8Base64(PROVISION_SCRIPT)
    }
    const commandId = await provider.startCommand(box.session.id, {
      command: 'bash',
      args: ['-c', SOURCE_BUILD_SCRIPT],
      env,
      timeoutMs: 40 * 60_000
    })
    await update(db, id, { session_id: box.session.id, command_id: commandId }, now)
    return 'source-started'
  } catch (error) {
    await fail(deps, id, name, String(error))
    return 'failed'
  }
}

async function desiredRelease(deps: GoldenImageDeps): Promise<{ tag: string; bundleUrl: string; sha256: string } | 'unavailable'> {
  const doFetch = deps.config.fetch ?? fetch
  let tag = deps.config.source!.slice('release:'.length)
  if (tag === 'latest') {
    const res = await doFetch('https://api.github.com/repos/stablyai/orca/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'orca-sandbox-control' }
    })
    if (!res.ok) {
      return 'unavailable'
    }
    tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? '')
  }
  try {
    return { tag, ...(await resolveReleaseBundle(tag, 'x64', doFetch)) }
  } catch {
    return 'unavailable'
  }
}

/** Clone the active image into a fresh snapshot (new TTL). Fits in one tick: boot, wipe, snapshot. */
async function startRefresh(deps: GoldenImageDeps, active: GoldenRow): Promise<GoldenTick> {
  const { db, provider } = deps
  const now = deps.now()
  const id = randomId()
  const name = `orca-${deps.config.environment}-golden-${id}`
  await insert(db, { id, source: `clone:${active.snapshot_id}`, bundle_sha256: active.bundle_sha256, status: 'building', build_name: name }, now)
  try {
    const box = await provider.createSandbox({
      name,
      snapshotId: active.snapshot_id!,
      vcpus: 2,
      region: deps.config.region,
      timeoutMs: 15 * 60_000,
      ports: [],
      networkPolicy: compileNetworkPolicy({ mode: 'allowlist', allowlist: [] }),
      tags: { orcaGoldenImage: id, orcaEnv: deps.config.environment },
      snapshotExpirationMs: 86_400_000
    })
    // A refresh also rolls out the control plane's current VM entry points (grant/revoke, start
    // script fixes) without waiting for the next release build.
    await installEntryPoints(deps, box.session.id)
    await finishBuild(deps, id, name, box.session.id)
    return 'refresh-started'
  } catch (error) {
    await fail(deps, id, name, String(error))
    return 'failed'
  }
}

async function startRelease(deps: GoldenImageDeps, release: { tag: string; bundleUrl: string; sha256: string }): Promise<GoldenTick> {
  const { db, provider } = deps
  const now = deps.now()
  const id = randomId()
  const name = `orca-${deps.config.environment}-golden-${id}`
  await insert(db, { id, source: `release:${release.tag}`, bundle_sha256: release.sha256, status: 'building', build_name: name }, now)
  try {
    const manifest: GoldenImageManifest = { ...MANIFEST, orcad: { bundleUrl: release.bundleUrl, sha256: release.sha256 } }
    const box = await provider.createBuildSandbox({
      name,
      image: manifest.image,
      vcpus: manifest.vcpus,
      region: deps.config.region,
      timeoutMs: BUILD_DEADLINE_MS,
      tags: { orcaGoldenImage: id, orcaEnv: deps.config.environment }
    })
    const commandId = await provider.startCommand(box.session.id, {
      command: 'bash',
      args: ['-c', PROVISION_SCRIPT],
      env: provisionEnv({ manifest, provisionScript: PROVISION_SCRIPT, vmScripts: VM_SCRIPT_SOURCES, buildId: id }),
      timeoutMs: 30 * 60_000
    })
    await update(db, id, { session_id: box.session.id, command_id: commandId }, now)
    return 'release-started'
  } catch (error) {
    await fail(deps, id, name, String(error))
    return 'failed'
  }
}

async function stepBuild(deps: GoldenImageDeps, row: GoldenRow): Promise<GoldenTick> {
  const now = deps.now()
  if (now - row.created_at > BUILD_DEADLINE_MS) {
    await fail(deps, row.id, row.build_name, 'build_deadline')
    return 'failed'
  }
  if (!row.session_id || !row.command_id) {
    return 'building'
  }
  const { exitCode } = await deps.provider.getCommand(row.session_id, row.command_id)
  if (exitCode === null) {
    return 'building'
  }
  if (exitCode !== 0) {
    await fail(deps, row.id, row.build_name, `provision_exit_${exitCode}`)
    return 'failed'
  }
  try {
    await finishBuild(deps, row.id, row.build_name!, row.session_id)
  } catch (error) {
    await fail(deps, row.id, row.build_name, String(error))
    return 'failed'
  }
  return 'built'
}

/** Wipe identity, snapshot (stops the box), drop the build box; the snapshot then waits for its smoke test. */
/** Rewrites /opt/orca/bin/<entry point> from VM_SCRIPT_SOURCES (same bytes a release build installs). */
export async function installEntryPoints(deps: { provider: Pick<SandboxProviderApi, 'runCommand'> }, sessionId: string): Promise<void> {
  const env = provisionEnv({ manifest: MANIFEST, provisionScript: PROVISION_SCRIPT, vmScripts: VM_SCRIPT_SOURCES, buildId: 'sync' })
  const scriptEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('ORCA_VM_SCRIPT_')))
  const install = [
    'set -euo pipefail',
    `for name in ${VM_SCRIPTS.join(' ')}; do`,
    '  var="ORCA_VM_SCRIPT_${name//[-.]/_}"',
    '  printf %s "${!var}" | base64 -d >"/tmp/$name.new"',
    '  sudo install -o root -g root -m 0755 "/tmp/$name.new" "/opt/orca/bin/$name"',
    '  rm -f "/tmp/$name.new"',
    'done',
    'echo synced'
  ].join('\n')
  const result = await deps.provider.runCommand(sessionId, { command: 'bash', args: ['-c', install], env: scriptEnv, timeoutMs: 60_000 })
  if (result.exitCode !== 0 || !result.stdout.includes('synced')) {
    throw new Error('entry_point_sync_failed')
  }
}

async function finishBuild(deps: GoldenImageDeps, id: string, name: string, sessionId: string): Promise<void> {
  const { provider } = deps
  const wipe = await provider.runCommand(sessionId, { command: WIPE, timeoutMs: 60_000 })
  if (wipe.exitCode !== 0 || !wipe.stdout.includes('"wiped":true')) {
    throw new Error('identity_wipe_failed')
  }
  const snapshotId = await provider.createSnapshot(sessionId, deps.config.expirationMs)
  await provider.deleteBuildSandbox(name)
  const snapshot = await provider.getSnapshot(snapshotId)
  await update(deps.db, id, { status: 'smoking', snapshot_id: snapshotId, expires_at: snapshot?.expiresAt ?? null }, deps.now())
}

/** Boot the candidate and require orcad ready before it serves a single user create. */
async function stepSmoke(deps: GoldenImageDeps, row: GoldenRow): Promise<GoldenTick> {
  const { db, provider } = deps
  const name = `orca-${deps.config.environment}-goldsmoke-${row.id}`
  try {
    const box = await provider.createSandbox({
      name,
      snapshotId: row.snapshot_id!,
      vcpus: 2,
      region: deps.config.region,
      timeoutMs: 10 * 60_000,
      ports: [ORCAD_PORT],
      networkPolicy: compileNetworkPolicy({ mode: 'allowlist' }),
      tags: { orcaGoldenSmoke: row.id, orcaEnv: deps.config.environment },
      snapshotExpirationMs: 86_400_000
    })
    await startOrcad(provider, box, { sandboxId: `smoke-${row.id}` })
  } catch (error) {
    await provider.deleteSandbox(name).catch(() => undefined)
    await fail(deps, row.id, null, `smoke_failed: ${String(error)}`)
    if (row.snapshot_id) {
      await provider.deleteSnapshot(row.snapshot_id).catch(() => undefined)
    }
    return 'failed'
  }
  await provider.deleteSandbox(name)
  const now = deps.now()
  // Atomic swap: the old active becomes retired (still bootable) in the same batch.
  await db.batch([
    db.prepare(`UPDATE golden_images SET status = 'retired', updated_at = ? WHERE status = 'active'`).bind(now),
    db.prepare(`UPDATE golden_images SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, row.id)
  ])
  // Keep one retired image as the rollback; older ones are deleted.
  for (const old of (await rows(db, ['retired'])).slice(1)) {
    if (old.snapshot_id) {
      await provider.deleteSnapshot(old.snapshot_id).catch(() => undefined)
    }
    await update(db, old.id, { status: 'deleted' }, now)
  }
  console.log(JSON.stringify({ event: 'golden_image_activated', id: row.id, source: row.source, snapshotId: row.snapshot_id }))
  return 'activated'
}

async function fail(deps: GoldenImageDeps, id: string, buildName: string | null, error: string): Promise<void> {
  if (buildName) {
    await deps.provider.deleteBuildSandbox(buildName).catch(() => undefined)
  }
  await update(deps.db, id, { status: 'failed', error: error.slice(0, 500) }, deps.now())
  console.log(JSON.stringify({ event: 'golden_image_failed', id, error: error.slice(0, 200) }))
}
