// WSL via orcad, phase 3 of the real-distro lane (R40 / E17): after the survive phase's teardown,
// a fresh orcad with a short idle timeout keeps its distro while a terminal is live, then
// idle-exits once it is closed and the holder lets the distro stop with no release call.
// Records guest and VM memory before and after. .github/workflows/wsl-orcad-e2e.yml runs it.
//
// Run: ORCA_RUN_WSL_ORCAD_LANE=1 pnpm test <this file>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { runProcess } from '@orca/process-host'
import { setAppEnvironment } from '../../shared/app-environment'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../shared/orcad-idle-exit'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { WSL_DISTRO_HOLDER_POLL_SECONDS } from './wsl-distro-holder-command'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { WslOrcadConnectionManager, type WslOrcadConnection } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import {
  createWslOrcadEnsureTrace,
  medianWslOrcadEnsurePhases,
  summarizeWslOrcadEnsurePhases,
  type WslOrcadEnsureMark,
  type WslOrcadEnsurePhases
} from './wsl-orcad-ensure-phase-trace'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { ORCAD_LOG_FILENAME } from '../managed-server/install/orcad-remote-host-support'
import {
  ORCAD_STARTUP_TIMING_ENV,
  ORCAD_STARTUP_TIMING_PREFIX
} from '../orcad/orcad-startup-timing'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { ORCAD_LAUNCHER_FILENAME } from '../../shared/orcad-artifacts'
import { verifyWslOrcadIdentity } from './wsl-orcad-pairing-identity'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

const RUN = process.env.ORCA_RUN_WSL_ORCAD_LANE === '1'
const PLAIN = process.env.ORCA_WSL_ORCAD_LANE_PLAIN_DISTRO ?? 'orca-lane-plain'
const WORK_DIR = process.env.ORCA_WSL_ORCAD_LANE_DIR ?? join(tmpdir(), 'orca-wsl-orcad-lane')
const USER_DATA = join(WORK_DIR, 'userData')
const STATE_FILE = join(WORK_DIR, 'launch-state.json')
const RECEIPT_DIR = process.env.ORCA_WSL_ORCAD_LANE_RECEIPTS ?? join(WORK_DIR, 'receipts')
const IDLE_TIMEOUT_MS = 15_000
// Idle period, one holder poll, then WSL's own stop of a distro with no client left.
const RELEASE_BUDGET_MS = IDLE_TIMEOUT_MS + WSL_DISTRO_HOLDER_POLL_SECONDS * 1000 + 90_000
const HELD_WITH_TERMINAL_MS = IDLE_TIMEOUT_MS + WSL_DISTRO_HOLDER_POLL_SECONDS * 1000 + 45_000

type Receipt = Record<string, unknown>
const receipt: Receipt = { phase: 'idle-release' }
const commandLog: string[] = []
receipt.commandLog = commandLog
let holder: WslDistroHolder
let manager: WslOrcadConnectionManager
/** NODE_OPTIONS for the next orcad launch; set only for the one profiled restart. */
let launchNodeOptions: string | null = null
const PROFILE_DIR = '/tmp/orca-lane-orcad-profiles'
/** Set only while a restart's ensure is measured. */
let ensureTrace: ReturnType<typeof createWslOrcadEnsureTrace> | null = null

function installLaneAppEnvironment(): void {
  const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  setAppEnvironment({
    getPath: (name) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => process.cwd(),
    getVersion: () => version,
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}

/** Each distro's template from the launch phase, so this phase does not update it. */
function launchTemplates(): Map<string, string> {
  const state: unknown = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  const templates =
    typeof state === 'object' && state !== null && 'templates' in state ? state.templates : null
  return new Map(
    Object.entries(typeof templates === 'object' && templates !== null ? templates : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

function createManager(): void {
  const templates = launchTemplates()
  const traced = <T>(start: WslOrcadEnsureMark, end: WslOrcadEnsureMark, run: () => Promise<T>) =>
    ensureTrace ? ensureTrace.span(start, end, run) : run()
  manager = new WslOrcadConnectionManager({
    holder: {
      ...holder,
      ensureHeld: (distro) => traced('holder-start', 'holder-end', () => holder.ensureHeld(distro))
    },
    listen: (transport, options) =>
      traced('bridge-start', 'bridge-end', () => listenWslOrcadStdioBridge(transport, options)),
    verifyIdentity: (offer, readiness) =>
      traced('pairing-start', 'pairing-end', () => verifyWslOrcadIdentity(offer, readiness)),
    // Logs every guest command with its time, to match the zombie's start time to one step.
    createTransport: (target) => {
      const transport = createWslOrcadHostTransport({ target })
      const log = (path: string, command: string): void => {
        ensureTrace?.command(command)
        commandLog.push(`${Math.round(performance.now())} ${path} ${command.slice(0, 160)}`)
      }
      return {
        ...transport,
        orcadLaunchEnv: async (launch) => [
          ...((await transport.orcadLaunchEnv?.(launch)) ?? []),
          [ORCAD_STARTUP_TIMING_ENV, '1'],
          ...(launchNodeOptions ? [['NODE_OPTIONS', launchNodeOptions] as const] : [])
        ],
        exec: (command, options) => {
          log('exec', command)
          return transport.exec(command, options)
        },
        execWithClosedStdin: (command, options) => {
          log('loop', command)
          return (
            transport.execWithClosedStdin?.(command, options) ?? transport.exec(command, options)
          )
        }
      }
    },
    deployAndLaunch: (distro, options) =>
      traced('deploy-start', 'deploy-end', () =>
        deployAndLaunchWslOrcad(distro, {
          ...options,
          templateDir: templates.get(wslDistroHolderKey(distro))
        })
      )
  })
}

/** Disposed after each command: a kept exec loop is a wsl.exe client that holds the distro up. */
async function guest(command: string): Promise<string> {
  const target = {
    kind: 'wsl' as const,
    id: defaultWslOrcadEnvironmentId(PLAIN),
    distro: PLAIN,
    label: PLAIN
  }
  const transport = createWslOrcadHostTransport({ target })
  try {
    return await execCommand(transport, command, { timeoutMs: 60_000 })
  } finally {
    transport.dispose()
  }
}

async function rpc<T>(connection: WslOrcadConnection, method: string, params?: unknown) {
  const offer = parsePairingCode(connection.pairingOffer)
  if (!offer) {
    throw new Error(`Unparseable pairing offer for ${connection.distro}`)
  }
  const response = await sendRemoteRuntimeRequest<T>(
    pairedRuntimeConnectionFromOffer(offer),
    method,
    params,
    30_000,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

async function plainRunning(): Promise<boolean> {
  const running = await readConfirmedRunningWslDistros()
  if (running.status !== 'confirmed') {
    throw new Error('wsl --list --running was unavailable')
  }
  return running.distros.some((d) => wslDistroHolderKey(d) === wslDistroHolderKey(PLAIN))
}

/** Working set (KiB) of the WSL VM process, or null once the VM has shut down. */
async function vmWorkingSetKiB(): Promise<number | null> {
  for (const image of ['vmmemWSL', 'vmmem']) {
    const result = await runProcess({
      program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'),
      args: ['/fi', `IMAGENAME eq ${image}`, '/fo', 'csv', '/nh'],
      cwd: resolveWslInteropSpawnCwd(),
      timeoutMs: 30_000
    })
    const row = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(`"${image}"`))
    const memory = row
      ?.split('","')
      .at(-1)
      ?.replace(/[^0-9]/gu, '')
    if (memory) {
      return Number(memory)
    }
  }
  return null
}

/** What Orca's processes and the whole guest use while the distro is held. */
async function guestMemory(): Promise<Receipt> {
  const out = await guest(
    'ps -u "$(id -u)" -o rss=,args= | awk \'!/awk/ && /orcad|node|orca-wsl-distro-holder/ {k+=$1} END {print k+0}\'; ' +
      "awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print t-a}' /proc/meminfo"
  )
  const [orcaRssKiB, guestUsedKiB] = out.trim().split(/\s+/u).map(Number)
  return { orcaRssKiB, guestUsedKiB }
}

/** Polls a real distro, whose state no fake clock moves. */
function waitFor<T>(
  what: string,
  read: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await read()
      if (value === null) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
      }
      return value
    },
    { timeout: timeoutMs, interval: intervalMs }
  )
}

async function idleReleasePhase(): Promise<void> {
  process.env[ORCAD_E2E_IDLE_TIMEOUT_ENV] = String(IDLE_TIMEOUT_MS)
  receipt.vmBeforeLaunchKiB = await vmWorkingSetKiB()
  // Aligns guest uptime with this process's clock for the command log.
  receipt.clockAlignment = `${Math.round(performance.now())} ${(await guest('cat /proc/uptime')).trim()}`
  let connection = await manager.ensure(PLAIN)
  // The release hunt: a zombie `cat` under a session init kept the distro up; find which step leaves it.
  const zombies =
    'cat /proc/uptime; for p in $(ps -eo pid=,stat= | awk \'$2 ~ /^Z/ {print $1}\'); do echo "Z $p $(cut -d" " -f4-8,22 /proc/$p/stat)"; done; ps -eo pid,ppid,sid,stat,args'
  receipt.processesAfterEnsure = await guest(zombies)
  await rpc(connection, 'status.get')
  receipt.processesAfterLaunch = await guest(zombies)
  const repoPath = (await guest('cd "$HOME/wsl-orcad-lane-repo" && pwd')).trim()
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })
  receipt.held = { ...(await guestMemory()), vmKiB: await vmWorkingSetKiB() }

  // No client, but a live terminal: orcad must not idle-exit and the holder must stay.
  await manager.dispose()
  // ast-grep-ignore: test-no-real-time-wait -- proves the distro stays up across the whole real idle window
  await new Promise((resolve) => setTimeout(resolve, HELD_WITH_TERMINAL_MS))
  expect(await plainRunning(), 'a live terminal keeps the distro').toBe(true)
  expect(await holder.holderState(PLAIN)).toBe('live')

  createManager()
  connection = await manager.ensure(PLAIN)
  expect(connection.pid, 'the same orcad served the reconnect').not.toBeNull()
  await rpc(connection, 'terminal.close', { terminal: created.terminal.handle })
  await manager.dispose()

  // No terminal left, but a detached job the user started (like tmux or nohup) still runs:
  // orcad idle-exits, yet the holder must keep the distro and its request unclaimed.
  await guest('setsid -f sleep 600 </dev/null >/dev/null 2>&1')
  // ast-grep-ignore: test-no-real-time-wait -- proves the hold across the whole real idle window
  await new Promise((resolve) => setTimeout(resolve, HELD_WITH_TERMINAL_MS))
  expect(await holder.holderState(PLAIN), 'a detached user job keeps the holder').toBe('live')
  expect(
    (await guest('[ -f "$HOME/.orca/wsl-holder-release" ] && echo yes || echo no')).trim()
  ).toBe('yes')
  // The bracket keeps pkill from matching the shell that runs it.
  await guest("pkill -f 'slee[p] 600' || true")
  const closedAt = performance.now()

  await waitFor(
    `${PLAIN} to stop after orcad idle-exits`,
    async () => ((await plainRunning()) ? null : true),
    RELEASE_BUDGET_MS
  ).catch(async (error: unknown) => {
    // The distro is still running, so this boots nothing: record what kept it.
    // Windows first: the guest probe below is itself a wsl.exe client.
    receipt.windowsWslClients = (await readWindowsProcessTableFresh())
      .filter((row) => /^wsl(host)?\.exe$/iu.test(row.name))
      .map((row) => `${row.pid} ${row.command}`)
    receipt.holderState = await holder.holderState(PLAIN)
    receipt.stillRunning = await guest(
      'cat /proc/uptime; ls -la "$HOME/.orca/wsl-holder-release" 2>&1; ps -eo pid,ppid,sid,stat,args | grep -v orca-wsl-exec-loop || true; for p in $(ps -eo pid=,ppid=,args= | awk \'$2 == 1 && $3 == "/init" {print $1}\'); do echo "INIT $p $(cut -d" " -f22 /proc/$p/stat)"; done'
    ).catch(String)
    throw error
  })
  receipt.secondsFromLastClientToDistroStop = Math.round((performance.now() - closedAt) / 1000)
  // Nothing here called release: the holder ended itself.
  expect(await holder.holderState(PLAIN)).toBe('exited')
  receipt.vmAfterStopKiB = await waitFor(
    'the WSL VM to shut down',
    async () => ((await vmWorkingSetKiB()) === null ? 0 : null),
    150_000,
    5_000
  ).catch(() => vmWorkingSetKiB())
}

async function wslExe(args: string[], timeoutMs = 120_000) {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args,
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    timeoutMs
  })
  return { code: result.code, output: `${result.stdout}${result.stderr}` }
}

async function terminatePlain(): Promise<void> {
  expect((await wslExe(['--terminate', PLAIN])).code).toBe(0)
  await waitFor('the distro to stop', async () => ((await plainRunning()) ? null : true), 60_000)
}

/** printf splits the token, so the typed command's echo never matches what the shell prints. */
function outputProbe(): { command: string; token: string } {
  const nonce = Math.random().toString(36).slice(2, 10)
  return { command: `printf 'COLD_%s\\n' ${nonce}`, token: `COLD_${nonce}` }
}

/** The newest startup timing line orcad logged; null when none parses. */
async function readOrcadStartupTiming(): Promise<unknown> {
  const line = await guest(
    `grep -hF ${quotePosixShell(ORCAD_STARTUP_TIMING_PREFIX)} "$HOME"/.orca-remote/orcad-*/${ORCAD_LOG_FILENAME} 2>/dev/null | tail -n 1`
  )
  try {
    return JSON.parse(
      line.slice(line.indexOf(ORCAD_STARTUP_TIMING_PREFIX) + ORCAD_STARTUP_TIMING_PREFIX.length)
    )
  } catch {
    return null
  }
}

/** (a) WSL host: holder boots the distro, orcad deploys and starts, a terminal spawns and prints. */
async function restartThroughHost(
  repoPath: string
): Promise<Receipt & { phases: WslOrcadEnsurePhases | null }> {
  await terminatePlain()
  createManager()
  const trace = createWslOrcadEnsureTrace()
  ensureTrace = trace
  const started = performance.now()
  trace.mark('ensure-start')
  const connection = await manager.ensure(PLAIN).finally(() => {
    trace.mark('ensure-end')
    ensureTrace = null
  })
  const ensureMs = Math.round(performance.now() - started)
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })
  const createdMs = Math.round(performance.now() - started)
  const probe = outputProbe()
  await rpc(connection, 'terminal.send', {
    terminal: created.terminal.handle,
    text: probe.command,
    enter: true
  })
  await waitFor(
    'the host terminal to print the probe',
    async () => {
      const read = await rpc<{ terminal: { tail?: unknown[] } }>(connection, 'terminal.read', {
        terminal: created.terminal.handle
      })
      return (read.terminal.tail ?? []).map(String).join('\n').includes(probe.token) ? true : null
    },
    120_000,
    100
  )
  const firstOutputMs = Math.round(performance.now() - started)
  const orcadStartup = await readOrcadStartupTiming()
  await rpc(connection, 'terminal.close', { terminal: created.terminal.handle }).catch(() => {})
  await manager.dispose()
  return {
    ensureMs,
    terminalCreatedMs: createdMs - ensureMs,
    firstOutputMs,
    phases: summarizeWslOrcadEnsurePhases(trace.events),
    orcadStartup
  }
}

/**
 * (b) Old bridge lower bound: one non-PTY `wsl.exe --exec` into the login shell. The real bridge
 * also starts ConPTY and paints, so this undercounts its first paint.
 */
async function restartThroughBridgeExec(): Promise<Receipt> {
  await terminatePlain()
  const probe = outputProbe()
  const started = performance.now()
  const result = await wslExe(
    // The same login-shell pick Orca's own WSL commands use (bash/zsh run -ilc, so rc files load).
    buildWslExecArgs(PLAIN, ['sh', '-c', buildWslLoginShellCommand(probe.command)])
  )
  const firstOutputMs = Math.round(performance.now() - started)
  expect(result.output).toContain(probe.token)
  return { firstOutputMs }
}

/**
 * One extra, unrecorded restart with orcad (and the Node children it starts) under --cpu-prof.
 * Profiles are written on exit, so wait for the idle exit, then copy them into the receipts.
 */
async function profileOrcadRestart(repoPath: string): Promise<string[]> {
  await guest(`rm -rf ${PROFILE_DIR}`)
  launchNodeOptions = `--cpu-prof --cpu-prof-dir=${PROFILE_DIR}`
  try {
    await restartThroughHost(repoPath)
  } finally {
    launchNodeOptions = null
  }
  // procps is not in every lane rootfs; the bracket keeps grep from matching its own argv.
  const serving = `for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done | grep -c '[${ORCAD_LAUNCHER_FILENAME[0]}]${ORCAD_LAUNCHER_FILENAME.slice(1)} --json' || true`
  await waitFor(
    'the profiled orcad to idle-exit',
    async () => ((await guest(serving)).trim() === '0' ? true : null),
    120_000,
    1000
  )
  const names = (await guest(`ls ${PROFILE_DIR} 2>/dev/null || true`)).split('\n').filter(Boolean)
  for (const name of names) {
    writeFileSync(
      join(RECEIPT_DIR, name),
      await guest(`cat ${quotePosixShell(`${PROFILE_DIR}/${name}`)}`)
    )
  }
  return names
}

/**
 * Distro restart (VM warm) to first command output, median of 3 each, alternating so neither path
 * always runs on a warmer VM.
 */
async function distroRestartBaseline(): Promise<void> {
  const repoPath = (await guest('cd "$HOME/wsl-orcad-lane-repo" && pwd')).trim()
  // One unrecorded bridge run warms the WSL VM, which the idle phase let shut down.
  await restartThroughBridgeExec()
  const host: Awaited<ReturnType<typeof restartThroughHost>>[] = []
  const bridge: Receipt[] = []
  for (let i = 0; i < 3; i++) {
    host.push(await restartThroughHost(repoPath))
    bridge.push(await restartThroughBridgeExec())
  }
  const median = (runs: Receipt[], key: string): number =>
    runs.map((run) => Number(run[key])).toSorted((a, b) => a - b)[1] ?? 0
  receipt.distroRestartToFirstOutput = {
    host,
    bridgeExecLowerBound: bridge,
    medianHostFirstOutputMs: median(host, 'firstOutputMs'),
    medianHostEnsureMs: median(host, 'ensureMs'),
    medianHostPhases: medianWslOrcadEnsurePhases(host.map((run) => run.phases)),
    medianBridgeExecLowerBoundMs: median(bridge, 'firstOutputMs')
  }
  receipt.orcadStartupProfiles = await profileOrcadRestart(repoPath)
  await terminatePlain()
}

describe.runIf(RUN && process.platform === 'win32')('WSL distro idle release', () => {
  beforeAll(() => {
    mkdirSync(USER_DATA, { recursive: true })
    mkdirSync(RECEIPT_DIR, { recursive: true })
    installLaneAppEnvironment()
    holder = createWslDistroHolder({ userDataPath: USER_DATA })
    createManager()
  })

  afterAll(async () => {
    await manager?.dispose().catch(() => {})
    await holder?.release(PLAIN).catch(() => {})
    writeFileSync(join(RECEIPT_DIR, 'idle-release.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  })

  // Real idle timeout, holder poll, WSL's own stop and VM shutdown, all on a live distro.
  it(
    'keeps a distro with a live terminal, then lets it stop once orcad idle-exits',
    idleReleasePhase,
    RELEASE_BUDGET_MS + 2 * HELD_WITH_TERMINAL_MS + 6 * 60_000
  )

  // After the idle phase: six distro restarts, a warm-up and one profiled restart, each bounded.
  it(
    'measures distro restart to first output for the WSL host and an old-bridge exec lower bound',
    distroRestartBaseline,
    24 * 60_000
  )
})
