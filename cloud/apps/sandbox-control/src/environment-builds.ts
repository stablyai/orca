// Environment builds: boot a VM from the golden image, clone the environment's repos, run its install
// script, snapshot the result. Versioned per environment (#1, #2, ...), with live logs, history,
// failure details and instant rollback (activate any kept build). A failed build never replaces the
// active one, and workspaces keep the build they booted from.
//
// No queue or Durable Object: a build advances whenever someone looks at it (log stream, GET) and on
// the cron, each step a compare-and-set on `generation`, so concurrent watchers cannot double-finalize.
import { ENVIRONMENT_BUILD_SCRIPT, ENVIRONMENT_DEPS_HOOK } from '../image/vm-scripts.generated'
import type { SandboxCaller } from './auth'
import type { EntitlementClient, MachineSize } from './entitlements'
import {
  EnvironmentError,
  getEnvironment,
  parseNames,
  parseRepos,
  repoDir,
  requireAdmin,
  type EnvironmentRepo,
  type EnvironmentRow
} from './environments'
import type { GitHubAppMinter } from './github-app'
import type { GoldenImageProviderApi } from './golden-image-provider'
import { assertStartsOpen, type GuardrailConfig, DEFAULT_GUARDRAILS } from './guardrails'
import { compileNetworkPolicy, gitBasicAuthorization, type CredentialRoute } from './network-policy'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { ORCAD_PORT, startOrcad } from './sandbox-vm-commands'
import type { Keyring } from './secrets-crypto'

export const BUILD_DEADLINE_MS = 45 * 60_000
const STARTING_STUCK_MS = 5 * 60_000
/** Finalization interrupted (a Worker cut off mid-snapshot) is recovered by the next look after this. */
const SNAPSHOTTING_STUCK_MS = 3 * 60_000
/** A secret value shorter than this is not redacted from logs (too likely to match ordinary text). */
const MIN_REDACTED_SECRET = 6
/** Event-stream keepalive; desktop watchers treat ~90 s of silence as a dead connection. */
const HEARTBEAT_MS = 20_000
/** Succeeded builds whose snapshot is kept (rollback window); older ones keep their record and log. */
export const KEPT_BUILDS = 5
const MAX_LOG_BYTES = 2 * 1024 * 1024
const LOG_HEAD_BYTES = 256 * 1024
const LOG_CHUNK = 256 * 1024
const VCPUS: Record<MachineSize, number> = { standard: 4, large: 8 }
const RESULT_PATH = '/tmp/orca-build/result.json'
const ORCAD_ENTRY = '/opt/orca/runtime/orcad/orcad-server.js'

export const LOCKFILES: readonly string[] = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements.txt', 'Gemfile.lock',
  'composer.lock', 'mix.lock', '.tool-versions', '.nvmrc', '.node-version', '.python-version', 'rust-toolchain.toml'
]

export type BuildStatus = 'starting' | 'running' | 'snapshotting' | 'succeeded' | 'failed' | 'canceled'
export const TERMINAL: ReadonlySet<BuildStatus> = new Set(['succeeded', 'failed', 'canceled'])

export type BuildRow = {
  id: string
  environment_id: string
  account_id: string
  number: number
  status: BuildStatus
  config: string
  base_snapshot_id: string
  provider_name: string
  session_id: string | null
  command_id: string | null
  snapshot_id: string | null
  result: string | null
  error: string | null
  failed_step: string | null
  log_bytes: number
  log_truncated: number
  created_by: string
  created_at: number
  started_at: number | null
  snapshot_started_at: number | null
  finished_at: number | null
  updated_at: number
  generation: number
  snapshot_deleted_at: number | null
  /** When billing accepted this build's VM time (null: not yet). */
  usage_reported_at: number | null
}

export type BuildConfig = {
  revision: number
  repos: EnvironmentRepo[]
  installScript: string
  envVarNames: string[]
  machineSize: MachineSize
}

export type BuildResult = {
  durationSec?: number
  repos?: { url: string; dir: string; branch: string; commit: string; lockfiles: Record<string, string> }[]
  diskUsedBytes?: number
  diskTotalBytes?: number
}

export type BuildDeps = {
  db: D1Database
  provider: SandboxProviderApi & GoldenImageProviderApi
  github?: GitHubAppMinter
  keyring?: Keyring
  entitlements: EntitlementClient
  now: () => number
  /** GitHub REST fetch for the staleness check (tests). */
  githubFetch?: typeof fetch
  /** Keeps finalization running after a watcher disconnects (Worker ctx.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * Hands a started build to its server-side runner (a Durable Object alarm in the Worker), so it
   * advances whether or not anyone is watching. Absent in tests that tick builds by hand.
   */
  schedule?: (build: { id: string; environmentId: string }) => Promise<void>
  config: { environment: string; goldenSnapshotId: string; region: string; guardrails?: GuardrailConfig }
}

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }))

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `bld_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function getBuild(db: D1Database, environmentId: string, id: string): Promise<BuildRow | null> {
  return db.prepare('SELECT * FROM environment_builds WHERE id = ? AND environment_id = ?').bind(id, environmentId).first<BuildRow>()
}

export async function listBuilds(db: D1Database, environmentId: string, limit = 30): Promise<BuildRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM environment_builds WHERE environment_id = ? ORDER BY number DESC LIMIT ?')
    .bind(environmentId, limit)
    .all<BuildRow>()
  return results
}

type Patch = Partial<Omit<BuildRow, 'id' | 'environment_id' | 'account_id' | 'number' | 'generation'>>

/** Compare-and-set on generation; null when someone else moved the build first. */
async function transition(db: D1Database, row: BuildRow, patch: Patch, now: number): Promise<BuildRow | null> {
  const entries = Object.entries(patch)
  const result = await db
    .prepare(
      `UPDATE environment_builds SET ${entries.map(([k]) => `${k} = ?`).join(', ')}${entries.length ? ', ' : ''}
         generation = generation + 1, updated_at = ? WHERE id = ? AND generation = ?`
    )
    .bind(...entries.map(([, v]) => v ?? null), now, row.id, row.generation)
    .run()
  return result.meta.changes === 1 ? getBuild(db, row.environment_id, row.id) : null
}

export function parseConfig(row: Pick<BuildRow, 'config'>): BuildConfig {
  return JSON.parse(row.config) as BuildConfig
}

export function parseResult(row: Pick<BuildRow, 'result'>): BuildResult | null {
  try {
    return row.result ? (JSON.parse(row.result) as BuildResult) : null
  } catch {
    return null
  }
}

function placeholder(buildId: string, index: number): string {
  return `orca-ph-${buildId}-r${index}`
}

/** Org secrets with the environment's names (personal secrets never reach a shared image). */
async function buildSecrets(deps: BuildDeps, accountId: string, names: string[]): Promise<Record<string, string>> {
  if (!deps.keyring || names.length === 0) {
    return {}
  }
  const marks = names.map(() => '?').join(', ')
  const { results } = await deps.db
    .prepare(`SELECT * FROM secrets WHERE scope = 'org' AND owner_id = ? AND name IN (${marks})`)
    .bind(accountId, ...names)
    .all<{ scope: 'org'; owner_id: string; name: string; kek_id: string; wrapped_dek: string; ciphertext: string }>()
  const env: Record<string, string> = {}
  for (const record of results) {
    try {
      env[record.name] = await deps.keyring.open(
        { scope: record.scope, ownerId: record.owner_id, name: record.name },
        { kekId: record.kek_id, wrappedDek: record.wrapped_dek, ciphertext: record.ciphertext }
      )
    } catch {
      log('build_secret_unreadable', { name: record.name })
    }
  }
  return env
}

export async function startBuild(deps: BuildDeps, caller: SandboxCaller, environment: EnvironmentRow): Promise<BuildRow> {
  requireAdmin(caller)
  const repos = parseRepos(environment)
  if (repos.length === 0) {
    throw new EnvironmentError('invalid_request', 400, 'no_repos')
  }
  await assertStartsOpen(deps.db, deps.config.guardrails ?? DEFAULT_GUARDRAILS)
  // Builds run on a VM: the account must be allowed to start sandboxes at all (not counted as one).
  const decision = await deps.entitlements.checkStart({
    accountId: environment.account_id,
    machineSize: environment.machine_size,
    runningSandboxes: 0,
    userId: caller.userId,
    runningSandboxesForUser: 0
  })
  if (!decision.allow) {
    throw new EnvironmentError('forbidden', 403, decision.reason ?? 'entitlement_denied')
  }
  for (const running of await listBuilds(deps.db, environment.id, 5)) {
    if (!TERMINAL.has(running.status)) {
      await advanceBuild(deps, running)
    }
  }
  const inFlight = (await listBuilds(deps.db, environment.id, 5)).find((b) => !TERMINAL.has(b.status))
  if (inFlight) {
    throw new EnvironmentError('conflict', 409, 'build_in_progress')
  }
  const now = deps.now()
  const id = randomId()
  const config: BuildConfig = {
    revision: environment.revision,
    repos,
    installScript: environment.install_script,
    envVarNames: parseNames(environment),
    machineSize: environment.machine_size
  }
  // Number allocation and insert in one batch: two admins clicking Build cannot share a number.
  const bumped = await allocate().catch((error: unknown) => {
    // A stale environment read collides on UNIQUE(environment_id, number): someone else just started one.
    if (String(error).includes('UNIQUE')) {
      throw new EnvironmentError('conflict', 409, 'build_in_progress')
    }
    throw error
  })
  async function allocate() {
    return deps.db.batch([
    deps.db
      .prepare('UPDATE environments SET next_build_number = next_build_number + 1 WHERE id = ? AND next_build_number = ?')
      .bind(environment.id, environment.next_build_number),
    deps.db
      .prepare(
        `INSERT INTO environment_builds (id, environment_id, account_id, number, status, config, base_snapshot_id,
           provider_name, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`
      )
      .bind(id, environment.id, environment.account_id, environment.next_build_number, JSON.stringify(config),
        deps.config.goldenSnapshotId, `orca-${deps.config.environment}-envbuild-${id}`, caller.userId, now, now)
  ])
  }
  if (bumped[0]?.meta.changes !== 1) {
    throw new EnvironmentError('conflict', 409, 'build_in_progress')
  }
  const row = (await getBuild(deps.db, environment.id, id))!
  log('environment_build_started', { buildId: id, environmentId: environment.id, number: row.number, repos: repos.length })
  try {
    const booted = await bootBuild(deps, row, config)
    // Progress is server-side from here: a client that never opens the log stream still gets a build.
    await deps.schedule?.({ id: booted.id, environmentId: booted.environment_id }).catch((error: unknown) =>
      log('environment_build_schedule_failed', { buildId: booted.id, error: String(error).slice(0, 120) })
    )
    return booted
  } catch (error) {
    const current = (await getBuild(deps.db, environment.id, id)) ?? row
    const code =
      error instanceof ProviderError
        ? `provider_${error.status}`
        : error instanceof EnvironmentError && error.reason === 'github_unavailable'
          ? 'github_unavailable'
          : 'boot_failed'
    await failBuild(deps, current, code === 'github_unavailable' ? 'clone' : 'boot', code)
    throw error
  }
}

async function bootBuild(deps: BuildDeps, row: BuildRow, config: BuildConfig): Promise<BuildRow> {
  const credentials: CredentialRoute[] = []
  const lines: string[] = []
  for (const [index, repo] of config.repos.entries()) {
    let header = ''
    // A minting error is not "public repo": cloning anonymously would end in a misleading 404 (seen live).
    const minted = deps.github
      ? await deps.github.tokenForRepo(repo.url, row.account_id).catch((error: unknown) => {
          log('environment_build_github_token_failed', { buildId: row.id, error: String(error).slice(0, 120) })
          throw new EnvironmentError('conflict', 409, 'github_unavailable')
        })
      : null
    if (minted) {
      const ph = placeholder(row.id, index)
      credentials.push({
        host: 'github.com',
        header: 'authorization',
        placeholders: [gitBasicAuthorization(ph)],
        via: 'transform',
        value: gitBasicAuthorization(minted.token)
      })
      header = `Authorization: ${gitBasicAuthorization(ph)}`
    }
    lines.push([repo.url, repo.defaultBranch ?? '', repoDir(repo.url), header].join('|'))
  }
  const box = await deps.provider.createSandbox({
    name: row.provider_name,
    snapshotId: row.base_snapshot_id,
    vcpus: VCPUS[config.machineSize],
    region: deps.config.region,
    timeoutMs: BUILD_DEADLINE_MS,
    ports: [],
    // Installs reach any registry; repo tokens are claimed per repo, anonymous clones still work.
    networkPolicy: compileNetworkPolicy({ mode: 'open', allowlist: [], credentials, denyUnclaimed: false }),
    tags: { orcaEnvBuild: row.id, orcaEnv: deps.config.environment },
    snapshotExpirationMs: 0,
    persistent: false
  })
  const secrets = await buildSecrets(deps, row.account_id, config.envVarNames)
  const env: Record<string, string> = {
    ...secrets,
    ORCA_BUILD_ID: row.id,
    ORCA_BUILD_REPOS: lines.join('\n'),
    ORCA_INSTALL_SCRIPT_B64: base64(config.installScript),
    ORCA_LOCKFILES: LOCKFILES.join(' '),
    ORCA_DEPS_HOOK_B64: base64(ENVIRONMENT_DEPS_HOOK)
  }
  log('environment_build_secrets', { buildId: row.id, injected: Object.keys(secrets).length, named: config.envVarNames.length })
  const commandId = await deps.provider.startCommand(box.session.id, {
    command: 'bash',
    args: ['-c', ENVIRONMENT_BUILD_SCRIPT],
    env,
    timeoutMs: BUILD_DEADLINE_MS - 5 * 60_000
  })
  const running = await transition(deps.db, row, {
    status: 'running',
    session_id: box.session.id,
    command_id: commandId,
    started_at: deps.now()
  }, deps.now())
  if (!running) {
    throw new EnvironmentError('conflict', 409, 'concurrent_transition')
  }
  return running
}

function base64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * One step forward: running -> (command ended) -> snapshotting -> succeeded | failed, plus deadline
 * and stuck handling. Returns the latest row. Safe to call from many watchers at once.
 */
export async function advanceBuild(deps: BuildDeps, row: BuildRow, options: { waitForExit?: boolean } = {}): Promise<BuildRow> {
  const now = deps.now()
  if (TERMINAL.has(row.status)) {
    return row
  }
  if (row.status === 'starting') {
    return now - row.created_at > STARTING_STUCK_MS ? ((await failBuild(deps, row, 'boot', 'boot_timeout')) ?? row) : row
  }
  if (row.status === 'snapshotting') {
    return now - row.updated_at > SNAPSHOTTING_STUCK_MS ? recoverInterrupted(deps, row) : row
  }
  if (!row.session_id || !row.command_id) {
    return row
  }
  if (now - (row.started_at ?? row.created_at) > BUILD_DEADLINE_MS) {
    return (await failBuild(deps, row, 'install', 'timeout')) ?? row
  }
  let exitCode: number | null
  try {
    exitCode = (await deps.provider.getCommand(row.session_id, row.command_id, { wait: options.waitForExit })).exitCode
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 404 || error.status === 410)) {
      return (await failBuild(deps, row, 'install', 'vm_lost')) ?? row
    }
    throw error
  }
  if (exitCode === null) {
    return row
  }
  const claimed = await transition(deps.db, row, { status: 'snapshotting', snapshot_started_at: now }, now)
  if (!claimed) {
    return (await getBuild(deps.db, row.environment_id, row.id)) ?? row
  }
  return finalize(deps, claimed, exitCode)
}

const EXIT_STEPS: Record<number, { step: string; error: string }> = {
  10: { step: 'clone', error: 'clone_failed' },
  20: { step: 'install', error: 'install_failed' },
  30: { step: 'record', error: 'record_failed' }
}

async function finalize(deps: BuildDeps, row: BuildRow, exitCode: number): Promise<BuildRow> {
  await storeLogs(deps, row).catch((error: unknown) => log('environment_build_log_store_failed', { buildId: row.id, error: String(error).slice(0, 200) }))
  if (exitCode !== 0) {
    const mapped = EXIT_STEPS[exitCode] ?? { step: 'install', error: `exit_${exitCode}` }
    return (await failBuild(deps, row, mapped.step, mapped.error)) ?? row
  }
  try {
    const sessionId = row.session_id!
    // The install script must not have broken Orca itself: every workspace needs orcad to start.
    const check = await deps.provider.runCommand(sessionId, {
      command: 'bash',
      args: ['-c', `test -f ${ORCAD_ENTRY} && cat ${RESULT_PATH}`],
      timeoutMs: 30_000
    })
    if (check.exitCode !== 0) {
      return (await failBuild(deps, row, 'record', 'runtime_removed')) ?? row
    }
    const result = check.stdout.trim().split('\n').at(-1) ?? '{}'
    JSON.parse(result)
    // Recorded before the snapshot: if this Worker is cut off mid-snapshot, the next look adopts the
    // snapshot by the build box's name (recoverInterrupted) with the result already in place.
    const recorded = await transition(deps.db, row, { result }, deps.now())
    if (!recorded) {
      return (await getBuild(deps.db, row.environment_id, row.id)) ?? row
    }
    const snapshotId = await deps.provider.createSnapshot(sessionId, 0)
    return completeBuild(deps, recorded, snapshotId)
  } catch (error) {
    log('environment_build_finalize_failed', { buildId: row.id, error: String(error).slice(0, 200) })
    return (await failBuild(deps, row, 'snapshot', 'snapshot_failed')) ?? row
  }
}

/**
 * Boot the new image once and require orcad to answer before any workspace gets it: an install script
 * that breaks Orca fails its own build instead of every later create. The first boot of a snapshot is
 * also its slowest (provider-side hydration), so a user never pays it.
 */
async function smokeBoot(deps: BuildDeps, row: BuildRow, snapshotId: string): Promise<void> {
  // Unique per attempt: a recovery pass racing this one must not delete our box (or we theirs).
  const name = `${row.provider_name}-smoke-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`
  try {
    const box = await deps.provider.createSandbox({
      name,
      snapshotId,
      vcpus: 2,
      region: deps.config.region,
      timeoutMs: 5 * 60_000,
      ports: [ORCAD_PORT],
      networkPolicy: compileNetworkPolicy({ mode: 'allowlist' }),
      tags: { orcaEnvBuildSmoke: row.id, orcaEnv: deps.config.environment },
      snapshotExpirationMs: 0,
      persistent: false
    })
    await startOrcad(deps.provider, box, { sandboxId: `smoke-${row.id}` })
  } finally {
    await deps.provider.deleteSandbox(name).catch(() => undefined)
  }
}

async function completeBuild(deps: BuildDeps, row: BuildRow, snapshotId: string): Promise<BuildRow> {
  await deps.provider.deleteBuildSandbox(row.provider_name).catch(() => undefined)
  // The smoke boot can take minutes: mark progress so no watcher takes this build for interrupted.
  row = (await transition(deps.db, row, {}, deps.now())) ?? row
  try {
    await smokeBoot(deps, row, snapshotId)
  } catch (error) {
    if (error instanceof ProviderError) {
      // The provider hiccuped, not the image: never throw away a finished build for that.
      log('environment_build_smoke_skipped', { buildId: row.id, status: error.status })
    } else {
      log('environment_build_smoke_failed', { buildId: row.id, error: String(error).slice(0, 200) })
      const failed = await transition(deps.db, row, { status: 'failed', failed_step: 'snapshot', error: 'smoke_failed', finished_at: deps.now() }, deps.now())
      if (failed) {
        // Ours to delete only when this pass is the one that failed the build.
        await deps.provider.deleteSnapshot(snapshotId).catch(() => undefined)
        log('environment_build_failed', { buildId: row.id, number: row.number, step: 'snapshot', error: 'smoke_failed' })
        await reportBuildUsage(deps, failed)
        return failed
      }
      return (await getBuild(deps.db, row.environment_id, row.id)) ?? row
    }
  }
  const now = deps.now()
  const done = await transition(deps.db, row, { status: 'succeeded', snapshot_id: snapshotId, finished_at: now }, now)
  const alive = await deps.db
    .prepare('SELECT 1 AS ok FROM environments WHERE id = ? AND deleted_at IS NULL')
    .bind(row.environment_id)
    .first<{ ok: number }>()
  if (!done || !alive) {
    // Failed meanwhile (deadline) or the environment was deleted: the snapshot is ours to clean up,
    // unless a racing pass already completed the build with this very snapshot.
    const current = done ?? (await getBuild(deps.db, row.environment_id, row.id))
    if (done || current?.snapshot_id !== snapshotId) {
      await deps.provider.deleteSnapshot(snapshotId).catch(() => undefined)
    }
    if (done) {
      await deps.db.prepare('UPDATE environment_builds SET snapshot_deleted_at = ? WHERE id = ?').bind(now, row.id).run()
    }
    return (await getBuild(deps.db, row.environment_id, row.id)) ?? row
  }
  await activateIfNewest(deps.db, done, now)
  await pruneSnapshots(deps, done.environment_id).catch((error: unknown) =>
    log('environment_build_prune_failed', { buildId: row.id, error: String(error).slice(0, 200) })
  )
  log('environment_build_succeeded', { buildId: row.id, number: row.number, ms: now - row.created_at, snapshotId })
  await reportBuildUsage(deps, done)
  return done
}

/** A finalize cut off mid-snapshot: adopt the snapshot the provider made for the build box, if any. */
async function recoverInterrupted(deps: BuildDeps, row: BuildRow): Promise<BuildRow> {
  const made = row.result
    ? (await deps.provider.listSnapshots(row.provider_name).catch(() => [])).find((s) => s.status === 'created')
    : undefined
  if (made) {
    log('environment_build_snapshot_recovered', { buildId: row.id, snapshotId: made.id })
    return completeBuild(deps, row, made.id)
  }
  return (await failBuild(deps, row, 'snapshot', 'snapshot_interrupted')) ?? row
}

/** A new success becomes active unless someone already activated a newer build. */
async function activateIfNewest(db: D1Database, build: BuildRow, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE environments SET active_build_id = ?, updated_at = ?
       WHERE id = ? AND (active_build_id IS NULL OR
         (SELECT number FROM environment_builds WHERE id = environments.active_build_id) < ?)`
    )
    .bind(build.id, now, build.environment_id, build.number)
    .run()
}

export async function activateBuild(db: D1Database, caller: SandboxCaller, environment: EnvironmentRow, build: BuildRow, now: number) {
  requireAdmin(caller)
  if (build.status !== 'succeeded' || !build.snapshot_id || build.snapshot_deleted_at !== null) {
    throw new EnvironmentError('conflict', 409, 'build_not_activatable')
  }
  // Guarded in SQL too: a prune that ran since `build` was read must not leave a pruned build active.
  const result = await db
    .prepare(
      `UPDATE environments SET active_build_id = ?, updated_at = ?, updated_by = ? WHERE id = ? AND EXISTS (
         SELECT 1 FROM environment_builds WHERE id = ? AND environment_id = ? AND status = 'succeeded'
           AND snapshot_id IS NOT NULL AND snapshot_deleted_at IS NULL)`
    )
    .bind(build.id, now, caller.userId, environment.id, build.id, environment.id)
    .run()
  if (result.meta.changes !== 1) {
    throw new EnvironmentError('conflict', 409, 'build_not_activatable')
  }
  log('environment_build_activated', { buildId: build.id, number: build.number, environmentId: environment.id })
  return (await getEnvironment(db, caller.accountId, environment.id))!
}

/** Keep the newest KEPT_BUILDS successful snapshots plus the active one; older ones are deleted. */
export async function pruneSnapshots(deps: Pick<BuildDeps, 'db' | 'provider' | 'now'>, environmentId: string): Promise<number> {
  const env = await deps.db.prepare('SELECT active_build_id FROM environments WHERE id = ?').bind(environmentId).first<{ active_build_id: string | null }>()
  const { results } = await deps.db
    .prepare(
      `SELECT * FROM environment_builds WHERE environment_id = ? AND status = 'succeeded'
         AND snapshot_id IS NOT NULL AND snapshot_deleted_at IS NULL ORDER BY number DESC`
    )
    .bind(environmentId)
    .all<BuildRow>()
  let pruned = 0
  for (const old of results.slice(KEPT_BUILDS)) {
    if (old.id === env?.active_build_id) {
      continue
    }
    try {
      // Resolves when already gone; any other failure leaves the row for the next prune.
      await deps.provider.deleteSnapshot(old.snapshot_id!)
    } catch (error) {
      log('environment_build_prune_snapshot_failed', { buildId: old.id, error: String(error).slice(0, 120) })
      continue
    }
    await deps.db.prepare('UPDATE environment_builds SET snapshot_deleted_at = ? WHERE id = ?').bind(deps.now(), old.id).run()
    pruned++
  }
  return pruned
}

async function failBuild(deps: BuildDeps, row: BuildRow, step: string, error: string): Promise<BuildRow | null> {
  const now = deps.now()
  const failed = await transition(deps.db, row, { status: 'failed', failed_step: step, error, finished_at: now }, now)
  if (failed) {
    if (row.log_bytes === 0 && row.session_id && row.command_id) {
      await storeLogs(deps, failed, { live: true }).catch(() => undefined)
    }
    await deps.provider.deleteSandbox(row.provider_name).catch(() => undefined)
    log('environment_build_failed', { buildId: row.id, number: row.number, step, error })
    await reportBuildUsage(deps, failed)
  }
  return failed ?? (await getBuild(deps.db, row.environment_id, row.id))
}

export async function cancelBuild(deps: BuildDeps, caller: SandboxCaller, row: BuildRow): Promise<BuildRow> {
  requireAdmin(caller)
  if (TERMINAL.has(row.status)) {
    return row
  }
  if (row.status === 'snapshotting') {
    throw new EnvironmentError('conflict', 409, 'build_finishing')
  }
  const now = deps.now()
  const canceled = await transition(deps.db, row, { status: 'canceled', finished_at: now, error: 'canceled' }, now)
  if (!canceled) {
    throw new EnvironmentError('conflict', 409, 'concurrent_transition')
  }
  await storeLogs(deps, canceled, { live: true }).catch(() => undefined)
  await deps.provider.deleteSandbox(row.provider_name).catch(() => undefined)
  log('environment_build_canceled', { buildId: row.id })
  await reportBuildUsage(deps, canceled)
  return (await getBuild(deps.db, row.environment_id, row.id)) ?? canceled
}

/** Copies the full provider log (bounded: head + tail) into D1 once the build is over. */
async function storeLogs(deps: BuildDeps, row: BuildRow, options: { live?: boolean } = {}): Promise<void> {
  if (!row.session_id || !row.command_id) {
    return
  }
  // A still-running command (cancel, timeout) never ends its stream: keep what arrives in a few seconds.
  const raw = await readUntil(
    await deps.provider.streamCommandLogs(row.session_id, row.command_id),
    options.live ? 5_000 : 60_000
  )
  const redact = await secretRedactor(deps, row)
  const text = raw
    .split('\n')
    .map((line) => {
      const parsed = parseLogLine(line)
      return parsed ? JSON.stringify({ ...parsed, data: redact(parsed.data) }) : ''
    })
    .filter(Boolean)
    .join('\n')
  let stored = text
  let truncated = 0
  if (text.length > MAX_LOG_BYTES) {
    const head = text.slice(0, LOG_HEAD_BYTES)
    const tail = text.slice(text.length - (MAX_LOG_BYTES - LOG_HEAD_BYTES))
    const cut = JSON.stringify({ stream: 'stderr', data: `\n[Orca: ${text.length - MAX_LOG_BYTES} bytes of build output omitted]\n` })
    stored = `${head.slice(0, head.lastIndexOf('\n') + 1)}${cut}\n${tail.slice(tail.indexOf('\n') + 1)}`
    truncated = 1
  }
  const statements = [deps.db.prepare('DELETE FROM environment_build_logs WHERE build_id = ?').bind(row.id)]
  for (let seq = 0; seq * LOG_CHUNK < stored.length; seq++) {
    statements.push(
      deps.db.prepare('INSERT INTO environment_build_logs (build_id, seq, data) VALUES (?, ?, ?)')
        .bind(row.id, seq, stored.slice(seq * LOG_CHUNK, (seq + 1) * LOG_CHUNK))
    )
  }
  statements.push(
    deps.db.prepare('UPDATE environment_builds SET log_bytes = ?, log_truncated = ? WHERE id = ?').bind(text.length, truncated, row.id)
  )
  await deps.db.batch(statements)
}

/** Reads a stream until it ends or `ms` pass, whichever is first; what arrived is returned. */
async function readUntil(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  const deadline = Date.now() + ms
  try {
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) {
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), left)
        })
      ])
      clearTimeout(timer)
      if (next === 'timeout' || next.done) {
        break
      }
      text += next.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

/**
 * Org secret values the install script received, replaced by `[secret NAME]` in every log Orca
 * shows or stores. (Files the script writes from them still land in the image: documented.)
 */
async function secretRedactor(deps: BuildDeps, row: BuildRow): Promise<(text: string) => string> {
  let names: string[] = []
  try {
    names = parseConfig(row).envVarNames
  } catch {
    names = []
  }
  const values = Object.entries(await buildSecrets(deps, row.account_id, names).catch(() => ({})))
    .filter(([, value]) => value.length >= MIN_REDACTED_SECRET)
    .sort((a, b) => b[1].length - a[1].length)
  if (values.length === 0) {
    return (text) => text
  }
  return (text) => values.reduce((acc, [name, value]) => acc.split(value).join(`[secret ${name}]`), text)
}

export async function storedLogs(db: D1Database, buildId: string): Promise<string> {
  const { results } = await db
    .prepare('SELECT data FROM environment_build_logs WHERE build_id = ? ORDER BY seq')
    .bind(buildId)
    .all<{ data: string }>()
  return results.map((r) => r.data).join('')
}

/**
 * A build ran a sandbox from its creation to its end (including the smoke boot): bill that time like
 * a workspace's, at the build's sandbox size, to the member who started it. Idempotent per build
 * (`build:<id>`); a billing outage leaves it for the cron.
 */
export async function reportBuildUsage(deps: Pick<BuildDeps, 'db' | 'entitlements' | 'now'>, row: BuildRow): Promise<boolean> {
  if (row.usage_reported_at !== null || row.finished_at === null || !TERMINAL.has(row.status)) {
    return false
  }
  // A build that never got a VM (refused before boot) used nothing.
  const startedAt = row.created_at
  const endedAt = Math.max(row.finished_at, startedAt)
  if (!row.session_id && row.status !== 'succeeded') {
    await deps.db.prepare('UPDATE environment_builds SET usage_reported_at = ? WHERE id = ?').bind(deps.now(), row.id).run()
    return false
  }
  let machineSize: MachineSize = 'standard'
  try {
    machineSize = parseConfig(row).machineSize ?? 'standard'
  } catch {
    machineSize = 'standard'
  }
  try {
    await deps.entitlements.reportUsage({
      usageId: `build:${row.id}`,
      accountId: row.account_id,
      sandboxId: row.id,
      machineSize,
      startedAt,
      endedAt,
      userId: row.created_by
    })
  } catch (error) {
    log('environment_build_usage_failed', { buildId: row.id, error: String(error).slice(0, 120) })
    return false
  }
  await deps.db.prepare('UPDATE environment_builds SET usage_reported_at = ? WHERE id = ?').bind(deps.now(), row.id).run()
  return true
}

/** Runner cadence: how soon to look again at a build in this state; null once it is final. */
export function nextBuildTickMs(row: Pick<BuildRow, 'status'>): number | null {
  switch (row.status) {
    case 'starting':
    case 'running':
      return 3_000
    case 'snapshotting':
      return 10_000
    default:
      return null
  }
}

/**
 * One server-side step for a build (the runner's alarm): advance it and say when to look again.
 * Independent of readers: the log stream and GET also advance, all through the same CAS steps.
 */
export async function tickBuild(deps: BuildDeps, environmentId: string, buildId: string): Promise<number | null> {
  const row = await getBuild(deps.db, environmentId, buildId)
  if (!row) {
    return null
  }
  const next = await advanceBuild(deps, row)
  if (TERMINAL.has(next.status) && next.usage_reported_at === null) {
    await reportBuildUsage(deps, (await getBuild(deps.db, environmentId, buildId)) ?? next)
  }
  return nextBuildTickMs(next)
}

/** Unfinished builds (the cron re-arms their runners in case one was lost). */
export async function unfinishedBuilds(db: D1Database): Promise<{ id: string; environment_id: string }[]> {
  const { results } = await db
    .prepare(`SELECT id, environment_id FROM environment_builds WHERE status IN ('starting', 'running', 'snapshotting') LIMIT 50`)
    .all<{ id: string; environment_id: string }>()
  return results
}

/** Cron: advance every unfinished build (finalize the ones nobody is watching). */
export async function advanceAllBuilds(deps: BuildDeps): Promise<number> {
  const { results } = await deps.db
    .prepare(`SELECT * FROM environment_builds WHERE status IN ('starting', 'running', 'snapshotting') ORDER BY updated_at LIMIT 20`)
    .all<BuildRow>()
  let moved = 0
  const { results: unbilled } = await deps.db
    .prepare(
      `SELECT * FROM environment_builds WHERE usage_reported_at IS NULL AND finished_at IS NOT NULL
         AND status IN ('succeeded', 'failed', 'canceled') ORDER BY finished_at LIMIT 20`
    )
    .all<BuildRow>()
  for (const row of unbilled) {
    await reportBuildUsage(deps, row)
  }
  for (const row of results) {
    try {
      const next = await advanceBuild(deps, row)
      if (next.status !== row.status) {
        moved++
      }
    } catch (error) {
      log('environment_build_advance_failed', { buildId: row.id, error: String(error).slice(0, 200) })
    }
  }
  return moved
}

/**
 * ndjson events for one build: `{"type":"build","build":{...}}` whenever its status changes, then
 * `{"type":"log","stream","data","at"}` for every chunk of output (from the first byte: a reconnect
 * replays), then `{"type":"end"}`. Live while the build runs; the stored log afterwards.
 */
export function streamBuildEvents(
  deps: BuildDeps,
  initial: BuildRow,
  view: (row: BuildRow) => Promise<unknown>,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const send = (event: unknown) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`))
  // A quiet step (snapshot, a long compile) prints nothing for minutes: a heartbeat tells watchers the
  // stream is alive so they don't reconnect (and replay the whole log) for nothing.
  const heartbeat = setInterval(() => {
    send({ type: 'heartbeat', at: deps.now() }).catch(() => clearInterval(heartbeat))
  }, HEARTBEAT_MS)
  const run = async () => {
    let row = initial
    await send({ type: 'build', build: await view(row) })
    // A build still booting gets its command id within seconds.
    for (let i = 0; i < 60 && row.status === 'starting'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      row = (await getBuild(deps.db, row.environment_id, row.id)) ?? row
    }
    if (row.status !== initial.status) {
      await send({ type: 'build', build: await view(row) })
    }
    const redact = await secretRedactor(deps, row)
    if ((row.status === 'running' || row.status === 'snapshotting') && row.session_id && row.command_id) {
      let reader: ReadableStreamDefaultReader<string> | undefined
      try {
        const upstream = await deps.provider.streamCommandLogs(row.session_id, row.command_id, signal)
        reader = upstream.pipeThrough(new TextDecoderStream()).getReader()
        let buffered = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          buffered += value
          const lines = buffered.split('\n')
          buffered = lines.pop() ?? ''
          for (const line of lines) {
            const parsed = parseLogLine(line)
            if (parsed) {
              await send({ type: 'log', ...parsed, data: redact(parsed.data), at: deps.now() })
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          return
        }
        log('environment_build_stream_interrupted', { buildId: row.id, error: String(error).slice(0, 120) })
      } finally {
        await reader?.cancel().catch(() => undefined)
      }
      const before = row.status
      if (row.status === 'running') {
        // The provider can drop a log stream while the command still runs: end this watch (the
        // client reconnects and replays) instead of announcing a snapshot that is not happening.
        // The exit code lags the end of the log by a moment (found live): wait for it, briefly.
        const exit = await Promise.race([
          deps.provider.getCommand(row.session_id, row.command_id, { wait: true }),
          new Promise<{ exitCode: null }>((resolve) => setTimeout(() => resolve({ exitCode: null }), 15_000))
        ]).catch(() => ({ exitCode: null }))
        if (exit.exitCode === null) {
          await send({ type: 'end' })
          return
        }
        await send({ type: 'build', build: await view({ ...row, status: 'snapshotting', snapshot_started_at: deps.now() }) })
      }
      const finishing = advanceBuild(deps, row, { waitForExit: true })
      deps.waitUntil?.(finishing)
      row = await finishing
      for (let i = 0; i < 120 && !TERMINAL.has(row.status); i++) {
        // Another watcher is finalizing (or the VM is still writing): wait for its outcome.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        row = await advanceBuild(deps, (await getBuild(deps.db, row.environment_id, row.id)) ?? row)
      }
      if (row.status !== before || TERMINAL.has(row.status)) {
        await send({ type: 'build', build: await view(row) })
      }
    } else if (TERMINAL.has(row.status)) {
      for (const line of (await storedLogs(deps.db, row.id)).split('\n')) {
        const parsed = parseLogLine(line)
        if (parsed) {
          // Stored logs are redacted already; this also covers secrets added since.
          await send({ type: 'log', ...parsed, data: redact(parsed.data) })
        }
      }
    }
    await send({ type: 'end' })
  }
  run()
    .catch((error: unknown) => {
      log('environment_build_stream_failed', { buildId: initial.id, error: String(error).slice(0, 200) })
      return send({ type: 'error', error: 'stream_failed' }).catch(() => undefined)
    })
    .finally(() => {
      clearInterval(heartbeat)
      return writer.close().catch(() => undefined)
    })
  return readable
}

function parseLogLine(line: string): { stream: 'stdout' | 'stderr'; data: string } | null {
  if (!line.trim()) {
    return null
  }
  try {
    const value = JSON.parse(line) as { stream?: string; data?: unknown }
    if ((value.stream === 'stdout' || value.stream === 'stderr') && typeof value.data === 'string') {
      return { stream: value.stream, data: value.data }
    }
  } catch {
    // Not ndjson: drop it rather than forward provider internals.
  }
  return null
}
