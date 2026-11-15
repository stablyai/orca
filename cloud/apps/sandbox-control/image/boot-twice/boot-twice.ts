// Boot-twice check for the golden image: provision it in a container, then boot the same disk twice
// through the control plane's own boot steps (entry-point probe, workspace prelude + start script,
// entry-point sync). The second boot runs with no network and must install and fetch nothing.
//   pnpm --filter @orca-cloud/sandbox-control exec tsx image/boot-twice/boot-twice.ts [options]
//     --release <vX.Y.Z|latest>  orcad bundle (default: the manifest's bundleUrl, else the latest release)
//     --image <tag>              boot an image built elsewhere (CI builds it with the layer cache)
//     --context-out <dir>        only write the docker build context and exit
//     --report <file>            write the JSON report there too
//     --keep                     leave the containers and the disk image for inspection
// Needs Docker that can run --privileged containers (Linux, Docker Desktop). See README.md.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENTRY_POINTS_PROBE, ensureEntryPoints, entryPointsBehind, installEntryPoints, parseEntryPointsProbe } from '../../src/golden-images'
import { startOrcad, type OrcadReady } from '../../src/sandbox-vm-commands'
import type { CommandResult, ProviderSandboxState, RunCommandParams, SandboxProviderApi } from '../../src/sandbox-provider'
import { ManifestSchema, VM_SCRIPTS, provisionEnv, resolveReleaseBundle, type BuildInputs, type GoldenImageManifest } from '../golden-image'
import { VM_SCRIPTS_HASH, VM_SCRIPTS_STAMP, WORKSPACE_PRELUDE_SCRIPT } from '../vm-scripts.generated'
import { entryPointMismatches, installerCommands, parseDockerDiff, pinnedTools, unexpectedChanges, versionMismatches, type DiffEntry, type ObservedVersions } from './boot-twice-checks'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url).href)
const HOME = '/home/ubuntu'
const FIXTURE_REPO = 'file:///srv/fixture.git'
const INSTALL_MARK = 'echo synced'

type Options = { release?: string; image?: string; contextOut?: string; report?: string; keep: boolean }

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  return { release: value('--release'), image: value('--image'), contextOut: value('--context-out'), report: value('--report'), keep: argv.includes('--keep') }
}

type Run = { code: number; stdout: string; stderr: string }

function docker(args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer)
      }
      resolve({ code: code ?? 124, stdout, stderr })
    })
    child.stdin.end(options.input ?? '')
  })
}

async function dockerOk(args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  const run = await docker(args, options)
  if (run.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${run.code}): ${run.stderr.slice(-1500)}`)
  }
  return run.stdout
}

/** Docker in buildx/build output mode: stream it, it takes minutes on a cold cache. */
function dockerStreamed(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed (${code})`))))
  })
}

// Env arrives on stdin as NUL-separated NAME=value pairs: values can be multi-line (the prelude
// script) and large (every entry point, base64), which argv `-e` handles badly.
const ENV_LOADER = 'while IFS= read -r -d "" kv; do export "$kv"; done; exec "$@"'

type CommandRecord = { boot: number; command: string; exitCode: number; ms: number; installed: boolean }

/** Just enough of the provider for the boot steps: runCommand and readFile, as `docker exec`. */
function dockerProvider(boot: () => number, commands: CommandRecord[]): SandboxProviderApi {
  const unsupported = (name: string) => () => Promise.reject(new Error(`boot-twice provider does not emulate ${name}`))
  return {
    async runCommand(container: string, params: RunCommandParams): Promise<CommandResult> {
      const started = Date.now()
      const input = Object.entries(params.env ?? {})
        .map(([key, val]) => `${key}=${val}\0`)
        .join('')
      const user = params.sudo ? 'root' : 'ubuntu'
      const run = await docker(
        ['exec', '-i', '-u', user, '-w', params.cwd ?? HOME, container, 'bash', '-c', ENV_LOADER, 'boot-twice-env', params.command, ...(params.args ?? [])],
        { input, timeoutMs: params.timeoutMs }
      )
      const script = params.args?.at(-1) ?? ''
      commands.push({
        boot: boot(),
        command: params.command === 'bash' ? `bash -c ${JSON.stringify(script.split('\n')[0]!.slice(0, 80))}` : params.command,
        exitCode: run.code,
        ms: Date.now() - started,
        installed: script.includes(INSTALL_MARK)
      })
      return { exitCode: run.code, stdout: run.stdout, stderr: run.stderr }
    },
    async readFile(container: string, path: string): Promise<string | null> {
      const run = await docker(['exec', '-u', 'ubuntu', container, 'cat', '--', path])
      return run.code === 0 ? run.stdout : null
    },
    createSandbox: unsupported('createSandbox'),
    getSandbox: unsupported('getSandbox'),
    stopSession: unsupported('stopSession'),
    extendTimeout: unsupported('extendTimeout'),
    updateNetworkPolicy: unsupported('updateNetworkPolicy'),
    updatePorts: unsupported('updatePorts'),
    updateSnapshotExpiration: unsupported('updateSnapshotExpiration'),
    deleteSandbox: unsupported('deleteSandbox'),
    listSnapshots: unsupported('listSnapshots'),
    deleteSnapshot: unsupported('deleteSnapshot'),
    listSandboxes: unsupported('listSandboxes'),
    listProjectSnapshots: unsupported('listProjectSnapshots')
  }
}

async function latestReleaseTag(): Promise<string> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'orca-boot-twice' }
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  const response = await fetch('https://api.github.com/repos/stablyai/orca/releases/latest', { headers })
  if (!response.ok) {
    throw new Error(`latest release lookup failed (HTTP ${response.status}); pass --release vX.Y.Z`)
  }
  return ((await response.json()) as { tag_name: string }).tag_name
}

function loadInputs(): BuildInputs {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(here('../golden-image.manifest.json'), 'utf8')))
  const vmScripts = Object.fromEntries(VM_SCRIPTS.map((name) => [name, readFileSync(here(`../vm/${name}`), 'utf8')])) as BuildInputs['vmScripts']
  return { manifest, provisionScript: readFileSync(here('../provision-golden.sh'), 'utf8'), vmScripts, vmScriptsStamp: VM_SCRIPTS_STAMP, buildId: 'boot-twice' }
}

async function withBundle(inputs: BuildInputs, release: string | undefined): Promise<BuildInputs> {
  if (!release && inputs.manifest.orcad.bundleUrl && inputs.manifest.orcad.sha256) {
    return inputs
  }
  const tag = !release || release === 'latest' ? await latestReleaseTag() : release
  const pinned = await resolveReleaseBundle(tag)
  return { ...inputs, manifest: { ...inputs.manifest, orcad: { bundleUrl: pinned.bundleUrl, sha256: pinned.sha256 } } }
}

/** The docker build context; its bytes are the layer cache key, so nothing in it varies per run. */
function writeContext(dir: string, inputs: BuildInputs): void {
  mkdirSync(dir, { recursive: true })
  const lines = Object.entries(provisionEnv(inputs)).map(([key, val]) => {
    if (val.includes("'")) {
      throw new Error(`provision env ${key} has a quote`)
    }
    return `${key}='${val}'`
  })
  writeFileSync(join(dir, 'provision.env'), `${lines.join('\n')}\n`)
  copyFileSync(here('../provision-golden.sh'), join(dir, 'provision-golden.sh'))
  copyFileSync(here('./Dockerfile'), join(dir, 'Dockerfile'))
  copyFileSync(here('./boot-twice-init'), join(dir, 'boot-twice-init'))
}

type BootReport = {
  boot: number
  network: boolean
  ms: number
  steps: Record<string, number>
  probe: { stamp: number; marker: boolean } | null
  ready: OrcadReady | null
  error?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(container: string, test: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await docker(['exec', container, 'sh', '-c', test])).code === 0) {
      return true
    }
    await sleep(250)
  }
  return false
}

// Quiet: no first-run work still running, and nothing outside the boot state paths written in the
// last 3 s. orcad installs agent hooks and OpenCode's first run ends a few seconds after ready.
const QUIET = [
  'pgrep -f "opencode [m]odels|agent-[p]refetch" >/dev/null && exit 1',
  `find ${HOME} /opt/orca -xdev \\( -path ${HOME}/.orca-sandbox -o -path ${HOME}/.orcad-data \\) -prune -o -newermt "-3 seconds" -print | grep -q . && exit 1`,
  'exit 0'
].join('\n')

async function settle(container: string): Promise<void> {
  await sleep(3_000)
  await waitFor(container, QUIET, 150_000)
}

// The DNS sink: answers every query NXDOMAIN and prints each name once ("lookup <name>").
const DNS_SINK = `
const seen = new Set()
const socket = require('node:dgram').createSocket('udp4')
socket.on('message', (msg, peer) => {
  if (msg.length < 12) return
  const labels = []
  let at = 12
  while (at < msg.length && msg[at] !== 0) { labels.push(msg.subarray(at + 1, at + 1 + msg[at]).toString()); at += msg[at] + 1 }
  const name = labels.join('.').toLowerCase()
  if (!seen.has(name)) { seen.add(name); console.log('lookup ' + name) }
  const reply = Buffer.from(msg.subarray(0, at + 5))
  reply[2] = 0x81; reply[3] = 0x83; reply.writeUInt16BE(0, 6); reply.writeUInt16BE(0, 8); reply.writeUInt16BE(0, 10)
  socket.send(reply, peer.port, peer.address)
})
socket.bind(53, () => console.log('sink ready'))
`

/** Names the harness itself makes up; anything else boot 2 looks up is a fetch attempt. */
const LOCAL_NAMES = /(^|\.)(invalid|localhost|local)$|^boot-twice(-\d+)?$/

type Sink = { network: string; ip: string; container: string }

async function startSink(image: string, runId: string): Promise<Sink> {
  const network = `orca-boot-twice-${runId}`
  const container = `orca-boot-twice-${runId}-dns`
  await dockerOk(['network', 'create', '--internal', network])
  await dockerOk(['run', '-d', '--name', container, '--network', network, '--user', 'root', image, 'node', '-e', DNS_SINK])
  const ip = (await dockerOk(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])).trim()
  const deadline = Date.now() + 15_000
  while (!(await docker(['logs', container])).stdout.includes('sink ready')) {
    if (Date.now() > deadline) {
      throw new Error('DNS sink did not start')
    }
    await sleep(200)
  }
  return { network, ip, container }
}

/**
 * Lookups every orcad start makes, by design: reported, not failed. orcad refreshes its agent-state
 * rules from the orca GitHub releases at start (and keeps working on its cached copy when offline).
 * The cost: a git fetch to github.com on boot 2 would hide behind this; the disk diff still catches
 * one that wrote anything.
 */
const RUNTIME_LOOKUPS: Readonly<Record<string, string>> = {
  'github.com': "orcad's agent-state-rules refresh at start"
}

async function sinkLookups(sink: Sink): Promise<{ unexpected: string[]; expected: string[] }> {
  const out = (await docker(['logs', sink.container])).stdout
  const names = [...out.matchAll(/^lookup (.+)$/gm)].map((match) => match[1]!).filter((name) => !LOCAL_NAMES.test(name))
  return { unexpected: names.filter((name) => !(name in RUNTIME_LOOKUPS)), expected: names.filter((name) => name in RUNTIME_LOOKUPS) }
}

/** One VM boot: a new container on the disk image, then the steps lifecycle.ts runs on create/wake. */
async function bootOnce(
  provider: SandboxProviderApi,
  image: string,
  container: string,
  boot: number,
  options: { network: boolean; prelude: boolean; sink?: { network: string; ip: string } }
): Promise<BootReport> {
  const steps: Record<string, number> = {}
  const time = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      return await step()
    } finally {
      steps[name] = Date.now() - started
    }
  }
  const report: BootReport = { boot, network: options.network, ms: 0, steps, probe: null, ready: null }
  // Offline: an internal network (no route out) whose only resolver is the DNS sink.
  const network = options.network ? [] : options.sink ? ['--network', options.sink.network, '--env', `BOOT_TWICE_DNS=${options.sink.ip}`] : ['--network', 'none']
  // Every boot records the commands it runs (/run/boot-twice-procs.log, sampled by the init).
  network.push('--env', 'BOOT_TWICE_TRACE=1')
  await dockerOk(['run', '-d', '--init', '--privileged', '--name', container, '--hostname', `boot-twice-${boot}`, '--tmpfs', '/run', ...network, image])
  if (!(await waitFor(container, 'test -e /run/boot-twice-ready', 30_000))) {
    throw new Error(`boot ${boot}: container init did not come up`)
  }
  const started = Date.now()
  try {
    // refreshRuntime (no runtime bundle published here): the probe, and an install only when behind.
    const probe = await time('probe', () => provider.runCommand(container, { command: 'bash', args: ['-c', ENTRY_POINTS_PROBE], sudo: true, timeoutMs: 40_000 }))
    report.probe = parseEntryPointsProbe(probe.stdout)
    if (entryPointsBehind(report.probe)) {
      await time('entryPointsBeforeStart', () => installEntryPoints({ provider }, container))
    }
    const state: ProviderSandboxState = {
      sandbox: { name: container, status: 'running', currentSessionId: container, currentSnapshotId: null, tags: {} },
      session: { id: container, status: 'running', startedAt: started, timeoutMs: 3_600_000 },
      routes: [{ port: 6768, url: 'https://boot-twice.invalid' }]
    }
    report.ready = await time('orcad', () =>
      startOrcad(provider, state, {
        sandboxId: `boot-twice-${boot}`,
        hostname: 'boot-twice',
        repo: { url: FIXTURE_REPO, ref: 'main' },
        docker: true,
        prelude: options.prelude ? { script: WORKSPACE_PRELUDE_SCRIPT } : undefined
      })
    )
    // settleMemberGit after ready: the per-boot entry-point check (an install at most once per image).
    await time('entryPointsAfterStart', () => ensureEntryPoints({ provider }, container))
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  report.ms = Date.now() - started
  return report
}

const VERSIONS_SCRIPT = `
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const [packages, binaries] = JSON.parse(process.argv[1])
const out = {}
for (const name of packages) {
  try { out[name] = JSON.parse(readFileSync('/opt/orca/tools/lib/node_modules/' + name + '/package.json', 'utf8')).version } catch { out[name] = null }
}
for (const name of binaries) {
  try {
    const text = execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
    out[name] = text.trim().split('\\n')[0] || null
  } catch { out[name] = null }
}
console.log(JSON.stringify(out))
`

// What a booted image carries: entry points (sha256), the scripts stamp and markers, orcad's
// version and whether it is listening on 6768 (0x1A70) on all interfaces.
const IMAGE_PROBE = [
  'cd /opt/orca/bin',
  'for f in * .scripts-stamp .entry-points-*; do [ -f "$f" ] && echo "file $(sha256sum "$f" | cut -d" " -f1) $f"; done',
  'echo "stamp $(cat .scripts-stamp 2>/dev/null || echo none)"',
  'echo "orcad_version $(cat /opt/orca/runtime/orcad/.version 2>/dev/null || echo none)"',
  'kill -0 "$(cat ~/.orca-sandbox/orcad.pid 2>/dev/null || echo 0)" 2>/dev/null && echo orcad_alive=1 || echo orcad_alive=0',
  'grep -qi " 00000000:1A70 00000000:0000 0A" /proc/net/tcp && echo orcad_listening=1 || echo orcad_listening=0',
  // Installers or fetchers still running after the boot answered.
  'echo "busy $(ps -eo args= | grep -E "^(apt|apt-get|dpkg|npm|npx|pip|curl|wget) |opencode [m]odels|git ([c]lone|[f]etch)" | head -3 | tr "\\n" ";")"'
].join('\n')

type Failure = string

async function checkImage(provider: SandboxProviderApi, container: string, manifest: GoldenImageManifest, failures: Failure[]) {
  const sources = Object.fromEntries(VM_SCRIPTS.map((name) => [name, createHash('sha256').update(readFileSync(here(`../vm/${name}`))).digest('hex')]))
  const probe = await provider.runCommand(container, { command: 'bash', args: ['-c', IMAGE_PROBE], timeoutMs: 30_000 })
  const installed: Record<string, string> = {}
  for (const match of probe.stdout.matchAll(/^file ([0-9a-f]{64}) (.+)$/gm)) {
    installed[match[2]!] = match[1]!
  }
  failures.push(...entryPointMismatches(sources, installed).map((problem) => `entry point ${problem}`))
  const stamp = /^stamp (.+)$/m.exec(probe.stdout)?.[1]
  if (stamp !== String(VM_SCRIPTS_STAMP)) {
    failures.push(`/opt/orca/bin/.scripts-stamp is ${stamp ?? 'unreadable'}, expected ${VM_SCRIPTS_STAMP}`)
  }
  if (!(`.entry-points-${VM_SCRIPTS_HASH}` in installed)) {
    failures.push(`no .entry-points-${VM_SCRIPTS_HASH} marker after two boots`)
  }
  if (!/^orcad_alive=1$/m.test(probe.stdout) || !/^orcad_listening=1$/m.test(probe.stdout)) {
    failures.push('orcad is not running and listening on :6768 after the second boot')
  }
  const busy = /^busy (.*)$/m.exec(probe.stdout)?.[1]?.trim()
  if (busy) {
    failures.push(`still installing or fetching after the second boot: ${busy}`)
  }
  const tools = pinnedTools(manifest)
  const run = await provider.runCommand(container, {
    command: 'bash',
    args: ['-lc', 'node -e "$1" "$2"', 'versions', VERSIONS_SCRIPT, JSON.stringify([tools.filter((t) => t.source === 'package').map((t) => t.name), tools.filter((t) => t.source === 'binary').map((t) => t.name)])],
    timeoutMs: 180_000
  })
  let observed: ObservedVersions = {}
  try {
    observed = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as ObservedVersions
  } catch {
    failures.push(`version probe failed (exit ${run.exitCode}): ${run.stderr.slice(-300)}`)
  }
  failures.push(...versionMismatches(tools, observed))
  return { orcadVersion: /^orcad_version (.+)$/m.exec(probe.stdout)?.[1] ?? null, versions: observed, entryPoints: Object.keys(installed).length }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const inputs = await withBundle(loadInputs(), options.release)
  if (options.contextOut) {
    writeContext(options.contextOut, inputs)
    console.log(JSON.stringify({ context: options.contextOut, bundleUrl: inputs.manifest.orcad.bundleUrl }))
    return
  }
  const runId = randomBytes(3).toString('hex')
  const started = Date.now()
  let image = options.image
  if (!image) {
    const context = mkdtempSync(join(tmpdir(), 'orca-boot-twice-'))
    writeContext(context, inputs)
    image = 'orca-boot-twice:local'
    console.error(`[boot-twice] building ${image} from ${context} (orcad ${inputs.manifest.orcad.bundleUrl})`)
    await dockerStreamed(['build', '--target', 'harness', '-t', image, context])
  }
  const buildMs = Date.now() - started
  const disk = `orca-boot-twice-disk:${runId}`
  const containers = [`orca-boot-twice-${runId}-1`, `orca-boot-twice-${runId}-2`] as const
  const commands: CommandRecord[] = []
  let current = 1
  const provider = dockerProvider(() => current, commands)
  const failures: Failure[] = []
  let diff: DiffEntry[] = []
  let unexpected: DiffEntry[] = []
  let image2: Awaited<ReturnType<typeof checkImage>> | null = null
  const boots: BootReport[] = []
  let sink: Sink | null = null
  let lookups: { unexpected: string[]; expected: string[] } = { unexpected: [], expected: [] }
  try {
    console.error('[boot-twice] boot 1 (first boot of the image, network on)')
    boots.push(await bootOnce(provider, image, containers[0], 1, { network: true, prelude: true }))
    // A VM lives a while after ready: let the first boot's background work finish before the disk is kept.
    await settle(containers[0])
    await dockerOk(['stop', '-t', '20', containers[0]])
    await dockerOk(['commit', containers[0], disk])
    current = 2
    console.error('[boot-twice] boot 2 (same disk, new boot id, no network)')
    sink = await startSink(image, runId)
    boots.push(await bootOnce(provider, disk, containers[1], 2, { network: false, prelude: false, sink }))
    for (const boot of boots) {
      if (boot.error || !boot.ready?.pairingCode.startsWith('orca://')) {
        failures.push(`boot ${boot.boot}: orcad did not come up (${boot.error ?? 'no pairing offer'})`)
      }
    }
    const reinstalls = commands.filter((command) => command.boot === 2 && command.installed)
    if (reinstalls.length > 0) {
      failures.push(`boot 2 reinstalled the entry points (${reinstalls.length}x): the first boot's marker did not stick`)
    }
    if (boots[1]?.probe && !boots[1].probe.marker) {
      failures.push('boot 2 probe: no entry-points marker for this tree')
    }
    // Give the second boot the same time to do (and show) anything it starts in the background.
    await settle(containers[1])
    const procs = await docker(['exec', containers[1], 'cat', '/run/boot-twice-procs.log'])
    failures.push(...installerCommands(procs.stdout.split('\n')).map((command) => `boot 2 ran ${JSON.stringify(command.slice(0, 160))}`))
    lookups = await sinkLookups(sink)
    failures.push(...lookups.unexpected.map((name) => `boot 2 tried to reach ${name}`))
    // The disk diff comes first: the version probe runs the agent CLIs, which write their own caches.
    diff = parseDockerDiff(await dockerOk(['diff', containers[1]]))
    unexpected = unexpectedChanges(diff, HOME)
    failures.push(...unexpected.map((entry) => `boot 2 changed ${entry.kind} ${entry.path}`))
    image2 = await checkImage(provider, containers[1], inputs.manifest, failures)
  } finally {
    if (!options.keep) {
      await docker(['rm', '-f', ...containers, ...(sink ? [sink.container] : [])])
      await docker(['rmi', '-f', disk])
      if (sink) {
        await docker(['network', 'rm', sink.network])
      }
    }
  }
  const report = {
    ok: failures.length === 0,
    failures,
    image,
    orcadBundle: inputs.manifest.orcad.bundleUrl,
    buildMs,
    boots: boots.map(({ ready, ...rest }) => ({ ...rest, ready: ready ? { projectRoot: ready.projectRoot } : null })),
    commands,
    boot2: { diff: diff.length, unexpected, lookups, ...image2 },
    totalMs: Date.now() - started
  }
  if (options.report) {
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report, null, 2))
  for (const boot of boots) {
    console.error(`[boot-twice] boot ${boot.boot}: ${boot.ms} ms ${JSON.stringify(boot.steps)}`)
  }
  console.error(report.ok ? '[boot-twice] OK: the second boot installed nothing' : `[boot-twice] FAILED:\n  ${failures.join('\n  ')}`)
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
