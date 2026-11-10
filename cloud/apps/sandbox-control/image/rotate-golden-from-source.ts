// Operator golden rotation from a git ref (default private/cloud/integration), the fallback while the
// Worker's own git-source build (GOLDEN_IMAGE_SOURCE=git:…) can't read the repo. Uploads `git archive`
// of the ref into a managed-image build sandbox, runs image/source-build.sh (orcad + bundled CLI from
// that commit, then provision-golden.sh), wipes identity, snapshots, smoke-boots the snapshot, and
// registers it as a `smoking` golden_images row with bundle_sha256 git:<sha>; the Worker cron then
// smoke-tests it again and swaps it in atomically (previous image kept as rollback).
//   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
//     npx tsx image/rotate-golden-from-source.ts [--ref private/cloud/integration] [--execute] [--no-register]
// Dry run by default. Every sandbox/snapshot it makes or deletes is appended to
// ~/.orca-cloud-ops/golden-ledger.jsonl (durable: /tmp does not survive reboots).
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'
import { ORCAD_PORT, START_COMMAND } from '../src/sandbox-vm-commands'
import { ManifestSchema, VM_SCRIPTS, provisionEnv, utf8Base64, type BuildInputs } from './golden-image'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url).href)
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback)
const ref = option('--ref', 'private/cloud/integration')
const ledgerDir = join(homedir(), '.orca-cloud-ops')
const log = (line: string) => console.error(`[rotate] ${line}`)

// `git archive` from a subdirectory archives only that subdirectory: always run at the repo root.
const repoRoot = here('../../../..')

function git(...gitArgs: string[]): Buffer {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs[0]} failed: ${result.stderr.toString().slice(0, 300)}`)
  }
  return result.stdout
}

function ledger(entry: Record<string, unknown>): void {
  mkdirSync(ledgerDir, { recursive: true })
  appendFileSync(join(ledgerDir, 'golden-ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

async function main(): Promise<void> {
  const sha = git('rev-parse', `${ref}^{commit}`).toString().trim()
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(here('./golden-image.manifest.json'), 'utf8')))
  const inputs: BuildInputs = {
    manifest,
    provisionScript: readFileSync(here('./provision-golden.sh'), 'utf8'),
    vmScripts: Object.fromEntries(VM_SCRIPTS.map((n) => [n, readFileSync(here(`./vm/${n}`), 'utf8')])) as BuildInputs['vmScripts'],
    buildId: sha.slice(0, 8)
  }
  console.log(JSON.stringify({ ref, sha, image: manifest.image, desktop: Boolean(manifest.desktop), execute: flag('--execute') }))
  if (!flag('--execute')) {
    return
  }
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env
  if (!token || !teamId || !projectId) {
    throw new Error('VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are required with --execute')
  }
  const api = createVercelSandboxApi({ token, teamId, projectId })
  const source = git('archive', '--format=tar.gz', sha)
  if (source.length < 10_000_000) {
    throw new Error(`source archive is only ${source.length} bytes; expected the whole repository`)
  }
  const name = `orca-golden-src-${sha.slice(0, 8)}-${Date.now().toString(36)}`
  const box = await api.createBuildSandbox({ name, image: manifest.image, vcpus: 8, region: manifest.region, timeoutMs: 60 * 60_000, tags: { orcaGoldenImage: sha.slice(0, 12) } })
  ledger({ created: 'sandbox', name })
  let snapshotId: string | null = null
  try {
    const sid = box.session.id
    const home = (await api.runCommand(sid, { command: 'bash', args: ['-c', 'mkdir -p "$HOME/orca-src" && echo "$HOME"'], timeoutMs: 30_000 })).stdout.trim()
    const upload = await fetch(`https://vercel.com/api/v2/sandboxes/sessions/${encodeURIComponent(sid)}/fs/write?teamId=${teamId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'x-cwd': `${home}/orca-src` },
      body: source
    })
    if (!upload.ok) {
      throw new Error(`source upload failed (${upload.status})`)
    }
    log(`uploaded ${sha.slice(0, 12)} (${Math.round(source.length / 1e6)} MB); building`)
    const started = Date.now()
    const commandId = await api.startCommand(sid, {
      command: 'bash',
      args: ['-c', readFileSync(here('./source-build.sh'), 'utf8')],
      env: { ...provisionEnv(inputs), ORCA_SRC_SHA: sha, ORCA_SRC_DIR: `${home}/orca-src`, ORCA_PROVISION_SCRIPT: utf8Base64(inputs.provisionScript) },
      timeoutMs: 40 * 60_000
    })
    let exitCode: number | null = null
    const marker = async (): Promise<number | null> => {
      const r = await api.runCommand(sid, { command: 'bash', args: ['-c', 'cat /tmp/source-build.exit 2>/dev/null'], timeoutMs: 20_000 }).catch(() => null)
      const code = r?.stdout.trim()
      return code && /^\d+$/.test(code) ? Number(code) : null
    }
    while (exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 15_000))
      ;({ exitCode } = await api.getCommand(sid, commandId, { wait: true, waitMs: 4_000 }))
      // The command status can stay "running" after the script exited; the marker file is the truth.
      exitCode ??= await marker()
      if (exitCode === null && Math.round((Date.now() - started) / 15_000) % 8 === 0) {
        // Every ~2 min: which build step is running (the newest step log's tail).
        const step = await api.runCommand(sid, { command: 'bash', args: ['-c', 'f=$(ls -t /tmp/src-*.log 2>/dev/null | head -1); echo "${f:-provisioning}: $(tail -c 160 "$f" 2>/dev/null | tr "\\n" " ")"'], timeoutMs: 20_000 }).catch(() => null)
        log(`${Math.round((Date.now() - started) / 1000)} s ${step?.stdout.trim() ?? ''}`)
      }
      if (Date.now() - started > 45 * 60_000) {
        throw new Error('build deadline')
      }
    }
    // Not the command log stream: it never ends while Vercel thinks the command is running.
    const logs = (
      await api.runCommand(sid, { command: 'bash', args: ['-c', 'cat /tmp/source-build.report 2>/dev/null | tail -c 4000'], timeoutMs: 20_000 })
    ).stdout
    log(`build+provision exit ${exitCode} in ${Math.round((Date.now() - started) / 1000)} s`)
    if (exitCode !== 0) {
      // The command has ended, so its log stream ends too; bounded in case the provider still holds it.
      const stream = await api.streamCommandLogs(sid, commandId, AbortSignal.timeout(20_000)).catch(() => null)
      const tail = stream ? await new Response(stream).text().catch(() => '') : ''
      throw new Error(`source build failed:\n${logs.slice(-1500)}\n${tail.slice(-4000)}`)
    }
    if (manifest.desktop && !/"desktop":\s*true/.test(logs)) {
      throw new Error('manifest pins a remote desktop but the provision report says it is missing')
    }
    const wipe = await api.runCommand(sid, { command: '/opt/orca/bin/orca-image-wipe', timeoutMs: 60_000 })
    if (wipe.exitCode !== 0 || !wipe.stdout.includes('"wiped":true')) {
      throw new Error('identity wipe failed')
    }
    snapshotId = await api.createSnapshot(sid, 0)
    ledger({ created: 'snapshot', id: snapshotId, sha })
    log(`snapshot ${snapshotId}`)
  } finally {
    await api.deleteBuildSandbox(name).catch(() => undefined)
    ledger({ deleted: 'sandbox', name })
  }
  await smoke(api, snapshotId!, sha)
  if (flag('--no-register')) {
    console.log(JSON.stringify({ snapshotId, sha, registered: false }))
    return
  }
  const now = Date.now()
  const sql = `INSERT INTO golden_images (id, source, bundle_sha256, status, snapshot_id, created_at, updated_at) VALUES ('gi_src_${now}', 'git:${ref} (operator build)', 'git:${sha}', 'smoking', '${snapshotId}', ${now}, ${now})`
  const insert = spawnSync('npx', ['wrangler', 'd1', 'execute', 'SANDBOX_DB', '-c', option('--wrangler-config', 'wrangler.dev.jsonc'), '--remote', '--command', sql], { cwd: here('..'), encoding: 'utf8' })
  if (insert.status !== 0) {
    throw new Error(`registering the snapshot failed: ${insert.stderr.slice(-500)}`)
  }
  console.log(JSON.stringify({ snapshotId, sha, registered: 'smoking' }))
}

/** The image must boot orcad from this commit with the tools agents expect, and survive stop/resume. */
async function smoke(api: ReturnType<typeof createVercelSandboxApi>, snapshotId: string, sha: string): Promise<void> {
  const name = `orca-golden-smoke-${Date.now().toString(36)}`
  const box = await api.createSandbox({
    name, snapshotId, vcpus: 4, region: 'iad1', timeoutMs: 15 * 60_000, ports: [ORCAD_PORT],
    networkPolicy: { allow: { 'registry.npmjs.org': [] } }, tags: { orcaGoldenSmoke: '1', orcaSandbox: 'smoke' }, snapshotExpirationMs: 86_400_000
  })
  ledger({ created: 'sandbox', name })
  try {
    const route = box.routes.find((r) => r.port === ORCAD_PORT)!.url
    const start = async (sessionId: string) => {
      const t = Date.now()
      const r = await api.runCommand(sessionId, { command: START_COMMAND, env: { ORCA_SANDBOX_ID: 'smoke', ORCA_PUBLIC_WSS: route.replace('https:', 'wss:') }, timeoutMs: 120_000 })
      if (r.exitCode !== 0) {
        throw new Error(`orcad did not start: ${r.stderr.slice(-500)}`)
      }
      return Date.now() - t
    }
    const first = await start(box.session.id)
    const checks = await api.runCommand(box.session.id, {
      command: 'bash',
      args: ['-lc', [
        `test "$(cat /opt/orca/runtime/orcad/SOURCE_COMMIT)" = "${sha}"`,
        'for b in orca rg tmux vim git-lfs gh claude codex opencode gemini cursor-agent copilot; do command -v $b >/dev/null || { echo "missing $b"; exit 1; }; done',
        // Each agent CLI starts (catches a broken pin or a pruned file it needed).
        'for b in opencode gemini cursor-agent copilot; do timeout 60 $b --version >/dev/null 2>&1 || { echo "$b --version failed"; exit 1; }; done',
        'orca status 2>&1 | grep -q "runtimeReachable: true"',
        'df -h / | awk \'NR==2{print "disk", $3 "/" $2}\'',
        'echo "opt-orca $(du -sm /opt/orca | cut -f1) MB"'
      ].join(' && ')],
      timeoutMs: 90_000
    })
    if (checks.exitCode !== 0) {
      throw new Error(`smoke checks failed: ${checks.stdout.slice(-300)} ${checks.stderr.slice(-300)}`)
    }
    await api.stopSession(box.session.id)
    const resumed = await api.getSandbox(name, { resume: true })
    const again = await start(resumed!.session.id)
    log(`smoke ok: orcad ${first} ms, after resume ${again} ms, ${checks.stdout.trim()}`)
  } finally {
    await api.deleteSandbox(name)
    for (const snapshot of await api.listSnapshots(name)) {
      if (snapshot.status !== 'deleted') {
        await api.deleteSnapshot(snapshot.id)
      }
    }
    ledger({ deleted: 'sandbox', name, withSnapshots: true })
  }
}

/** `--cleanup`: delete every sandbox the ledger created and never deleted (an interrupted run). */
async function cleanup(): Promise<void> {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env
  const api = createVercelSandboxApi({ token: token!, teamId: teamId!, projectId: projectId! })
  const lines = readFileSync(join(ledgerDir, 'golden-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const deleted = new Set(lines.filter((l) => l.deleted === 'sandbox').map((l) => l.name))
  for (const { name } of lines.filter((l) => l.created === 'sandbox' && !deleted.has(l.name))) {
    await api.deleteSandbox(name)
    for (const snapshot of await api.listSnapshots(name)) {
      if (snapshot.status !== 'deleted') {
        await api.deleteSnapshot(snapshot.id)
      }
    }
    ledger({ deleted: 'sandbox', name, withSnapshots: true, by: 'cleanup' })
    log(`deleted orphan ${name}`)
  }
}

;(flag('--cleanup') ? cleanup() : main()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
