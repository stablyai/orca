// C10 real WSL2/systemd-on/off contract: C4 deploy, C5 RPC bridge, C6 loss/recovery, E1 deferred/forced/idle updates, then a separate survive process proves holder adoption, git/folder chat and cleanup. wsl-orcad-e2e.yml imports/runs both phases.
// Run: ORCA_RUN_WSL_ORCAD_LANE=1 ORCA_WSL_ORCAD_LANE_PHASE=launch|survive pnpm test <this file>
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { runProcess } from '@orca/process-host'
import { setAppEnvironment } from '../../shared/app-environment'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import {
  ORCAD_LAUNCHER_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME
} from '../../shared/orcad-artifacts'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { proveWslStructuredChat } from './wsl-orcad-structured-chat-contract'
import { WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { WslOrcadConnectionManager, type WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import type { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'

const RUN = process.env.ORCA_RUN_WSL_ORCAD_LANE === '1'
const PHASE = process.env.ORCA_WSL_ORCAD_LANE_PHASE ?? 'launch'
const PLAIN = process.env.ORCA_WSL_ORCAD_LANE_PLAIN_DISTRO ?? 'orca-lane-plain'
// Rootfs families without systemd leave this empty and run only the plain distro.
const SYSTEMD = process.env.ORCA_WSL_ORCAD_LANE_SYSTEMD_DISTRO ?? 'orca-lane-systemd'
const DISTROS = [
  { name: PLAIN, systemd: false },
  ...(SYSTEMD ? [{ name: SYSTEMD, systemd: true }] : [])
]
const WORK_DIR = process.env.ORCA_WSL_ORCAD_LANE_DIR ?? join(tmpdir(), 'orca-wsl-orcad-lane')
const USER_DATA = join(WORK_DIR, 'userData')
const STATE_FILE = join(WORK_DIR, 'launch-state.json')
const RECEIPT_DIR = process.env.ORCA_WSL_ORCAD_LANE_RECEIPTS ?? join(WORK_DIR, 'receipts')
const HOLDER_SURVIVAL_MS = 60_000
const DISTRO_TIMEOUT_MS = 12 * 60_000
const BRIDGE_PATTERN = '[o]rcadStdioBridge'
const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop'
// E5: orcad Git must inherit login exports even though --exec sources no rc.
const LOGIN_ENV_SOCK = '/tmp/orca-lane-agent.sock'
const LOGIN_ENV_TAG = 'orca-lane-login-env'
const LANE_REPO = '$HOME/wsl-orcad-lane-repo'

type LaunchState = {
  launchEndedAtMs: number
  orcadPids: Record<string, number | null>
  /** The template each distro last deployed from, so the survive phase does not update it. */
  templates: Record<string, string>
}
type Receipt = Record<string, unknown>

const receipt: Receipt = { phase: PHASE }
const interopChecks: Receipt[] = []
receipt.wslInterop = interopChecks
const statuses = new Map<string, WslOrcadConnectionStatus[]>()
let visibleWork = true
let holder: WslDistroHolder
let manager: WslOrcadConnectionManager
let supervisor: WslOrcadLivenessSupervisor | null = null
// Per distro key; unset deploys the packaged template (ORCA_ORCAD_TEMPLATE_PATH).
const templates = new Map<string, string>()

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

function statusLog(distro: string): WslOrcadConnectionStatus[] {
  const key = wslDistroHolderKey(distro)
  const log = statuses.get(key) ?? []
  statuses.set(key, log)
  return log
}

function transportFor(distro: string) {
  return createWslOrcadHostTransport({
    target: {
      kind: 'wsl',
      id: defaultWslOrcadEnvironmentId(distro),
      distro,
      label: distro
    }
  })
}

/** As the distro's default user, through the same transport orcad's deploy uses. */
function guest(distro: string, command: string): Promise<string> {
  return execCommand(transportFor(distro), command, { timeoutMs: 60_000 })
}

async function wslExe(args: string[], timeoutMs = 60_000) {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args,
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    timeoutMs
  })
  return {
    code: result.code,
    output: `${result.stdout}${result.stderr}`.trim()
  }
}

function asRoot(distro: string, script: string) {
  return wslExe(buildWslExecArgs(distro, ['sh', '-c', script], { user: 'root' }))
}

/** WSL < 3.0.1 lost this VM-wide entry when a systemd distro stopped (microsoft/WSL#13885). */
async function assertWslInteropIntact(viaDistro: string, label: string): Promise<void> {
  const probe = await asRoot(
    viaDistro,
    `if [ -e ${WSL_INTEROP} ]; then echo present; else ` +
      `echo ':WSLInterop:M::MZ::/init:P' > /proc/sys/fs/binfmt_misc/register && echo restored; fi`
  )
  interopChecks.push({ label, viaDistro, result: probe.output })
  // Repair for later runner jobs, but still fail this lane on the detected wipe.
  expect(probe.output, `WSLInterop ${label}`).toBe('present')
  const ver = await guest(viaDistro, '/mnt/c/Windows/System32/cmd.exe /c ver')
  expect(ver).toMatch(/Windows/u)
}

async function waitFor<T>(
  what: string,
  read: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 100
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined) {
      return value
    }
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function waitForStatus<S extends WslOrcadConnectionStatus['state']>(
  distro: string,
  since: number,
  state: S,
  timeoutMs: number
): Promise<Extract<WslOrcadConnectionStatus, { state: S }>> {
  return waitFor(
    `${distro} to report ${state} (saw ${JSON.stringify(statusLog(distro).slice(since))})`,
    () =>
      statusLog(distro)
        .slice(since)
        .find((status): status is Extract<WslOrcadConnectionStatus, { state: S }> => {
          return status.state === state
        }),
    timeoutMs
  )
}

function pairedConnection(connection: WslOrcadConnection) {
  const offer = parsePairingCode(connection.pairingOffer)
  if (!offer) {
    throw new Error(`Unparseable pairing offer for ${connection.distro}`)
  }
  return pairedRuntimeConnectionFromOffer(offer)
}

async function rpc<T>(connection: WslOrcadConnection, method: string, params?: unknown) {
  const response = await sendRemoteRuntimeRequest<T>(
    pairedConnection(connection),
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

async function runningDistros(): Promise<string[]> {
  const running = await readConfirmedRunningWslDistros()
  if (running.status !== 'confirmed') {
    throw new Error('wsl --list --running was unavailable')
  }
  return running.distros.map(wslDistroHolderKey)
}

/** Windows-side wsl.exe children still carrying a bridge or a holder for this lane's distros. */
async function laneWindowsProcesses(): Promise<string[]> {
  const names = DISTROS.map((d) => d.name.toLowerCase())
  return (await readWindowsProcessTableFresh())
    .filter((row) => /^wsl(host)?\.exe$/iu.test(row.name))
    .map((row) => row.command)
    .filter((command) => names.some((name) => command.toLowerCase().includes(name)))
    .filter(
      (command) =>
        command.includes('orcadStdioBridge') || command.includes(WSL_DISTRO_HOLDER_MARKER)
    )
}

/** A closed bridge's guest half ends on stdin EOF, a moment after the Windows side. */
async function expectNoGuestBridges(distro: string): Promise<void> {
  const count = async () =>
    Number.parseInt(await guest(distro, `pgrep -fc '${BRIDGE_PATTERN}' || true`), 10) || 0
  const left = await waitFor(
    `bridges in ${distro} to exit`,
    async () => ((await count()) === 0 ? 0 : null),
    15_000,
    500
  ).catch(count)
  expect(left, `bridges left in ${distro}`).toBe(0)
}

function createLaneManager(): void {
  holder = createWslDistroHolder({
    userDataPath: USER_DATA,
    onHolderExit: (distro, exit) => supervisor?.noteHolderExit(distro, exit)
  })
  manager = new WslOrcadConnectionManager({
    holder,
    deployAndLaunch: (distro, options) =>
      deployAndLaunchWslOrcad(distro, {
        ...options,
        templateDir: templates.get(wslDistroHolderKey(distro))
      }),
    onChange: (distro, _connection, status) => {
      statusLog(distro).push(status)
      console.log(`[lane] ${distro} ${JSON.stringify(status)}`)
    }
  })
}

/** Runs `command` in a terminal and waits for a printf-split token the echoed input never matches. */
async function runInTerminal(
  connection: WslOrcadConnection,
  handle: string,
  command: string,
  what: string
): Promise<void> {
  const nonce = randomBytes(6).toString('hex')
  await rpc(connection, 'terminal.send', {
    terminal: handle,
    text: `${command} && printf 'WSL_LANE_%s\\n' ${nonce}`,
    enter: true
  })
  await waitFor(
    what,
    async () => {
      const read = await rpc<{ terminal: { tail?: unknown[] } }>(connection, 'terminal.read', {
        terminal: handle
      })
      return (read.terminal.tail ?? []).map(String).join('\n').includes(`WSL_LANE_${nonce}`)
        ? true
        : null
    },
    60_000,
    500
  )
}

/** After launching wsl.exe exits, prove orcad Git inherits login exports and terminals retain Windows interop. */
async function proveDetachedSession(
  connection: WslOrcadConnection,
  distro: string
): Promise<Receipt> {
  const repoPath = (
    await guest(
      distro,
      `set -e; cd "${LANE_REPO}"; rm -f "$HOME/${LOGIN_ENV_TAG}"; ` +
        `printf '#!/bin/sh\\nprintf %%s "$SSH_AUTH_SOCK" > "$HOME/${LOGIN_ENV_TAG}"\\n' ` +
        '> .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; ' +
        'git config user.email lane@orca.test; git config user.name lane; ' +
        'date +%s%N > lane-file; git add lane-file; pwd'
    )
  ).trim()
  await rpc(connection, 'git.commit', { worktree: `path:${repoPath}`, message: 'lane commit' })
  const hookSock = (await guest(distro, `cat "$HOME/${LOGIN_ENV_TAG}" 2>/dev/null || true`)).trim()
  expect(hookSock, `${distro}: SSH_AUTH_SOCK seen by orcad's git`).toBe(LOGIN_ENV_SOCK)
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })
  await runInTerminal(
    connection,
    created.terminal.handle,
    '/mnt/c/Windows/System32/cmd.exe /c ver',
    `Windows interop from a terminal in ${distro}`
  )
  return { hookSshAuthSock: hookSock, terminalInterop: 'ok' }
}

/** status, repo add on a fresh `git init`, terminal create, and its output read back. */
async function proveRuntimeRpc(connection: WslOrcadConnection, distro: string): Promise<Receipt> {
  const status = await rpc<{ runtimeId?: string }>(connection, 'status.get')
  expect(status.runtimeId).toEqual(expect.any(String))
  const repoPath = (
    await guest(
      distro,
      `set -e; d="${LANE_REPO}"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; ` +
        'git init -q -b main; git -c user.email=lane@orca.test -c user.name=lane ' +
        'commit -q --allow-empty -m seed; printf %s "$d"'
    )
  ).trim()
  const added = await rpc<{ repo: { id: string } }>(connection, 'repo.add', {
    path: repoPath
  })
  expect(added.repo.id).toEqual(expect.any(String))
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })
  const handle = created.terminal.handle
  expect(handle).toEqual(expect.any(String))
  await runInTerminal(connection, handle, ':', `terminal output token in ${distro}`)
  return {
    runtimeId: status.runtimeId,
    repoId: added.repo.id,
    terminal: handle
  }
}

/** The packaged template with a different orcad build, as the next app release ships one. */
function nextTemplate(label: string): string {
  const packaged = process.env.ORCA_ORCAD_TEMPLATE_PATH
  if (!packaged) {
    throw new Error('ORCA_ORCAD_TEMPLATE_PATH must name the packaged orcad template')
  }
  const dir = join(WORK_DIR, `template-${label}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(packaged, dir, { recursive: true })
  const launcher = join(dir, ORCAD_LAUNCHER_FILENAME)
  appendFileSync(launcher, `\n// wsl-orcad-lane build ${label}\n`)
  const manifestPath = join(dir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.commonSha256[ORCAD_LAUNCHER_FILENAME] = createHash('sha256')
    .update(readFileSync(launcher))
    .digest('hex')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return dir
}

async function waitForNoLiveTerminals(connection: WslOrcadConnection): Promise<void> {
  await waitFor(
    'the closed terminal to leave the census',
    async () =>
      (await requestOrcadTerminalCensus(pairedConnection(connection), 0)).liveSessions === 0
        ? true
        : null,
    30_000,
    500
  )
}

/** App updates (E1): N -> N+1 over a live terminal, N+2 idle, N+3 after a reboot. */
async function updatePhase(distro: string): Promise<Receipt> {
  const result: Receipt = {}
  if (!supervisor) {
    throw new Error('supervisor missing')
  }
  const key = wslDistroHolderKey(distro)
  const before = await supervisor.connect(distro)
  // The launch phase added this repo; its terminals died with the distro.
  const worktree = `path:${(await guest(distro, 'printf %s "$HOME/wsl-orcad-lane-repo"')).trim()}`
  const openTerminal = async (connection: WslOrcadConnection): Promise<string> => {
    const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
      worktree
    })
    await runInTerminal(connection, created.terminal.handle, ':', `terminal in ${distro}`)
    return created.terminal.handle
  }
  const terminal = await openTerminal(before)

  // Live terminals defer updates while the incumbent serves.
  templates.set(key, nextTemplate('n1'))
  let started = performance.now()
  const deferred = await supervisor.connect(distro)
  result.deferMs = Math.round(performance.now() - started)
  expect(deferred.fullVersion).toBe(before.fullVersion)
  expect(deferred.deferredUpdate).toMatchObject({
    code: 'orcad_update_terminals_running',
    forceable: true
  })
  result.deferred = deferred.deferredUpdate
  await runInTerminal(deferred, terminal, ':', `terminal under the incumbent in ${distro}`)

  // Force switches builds while the preserved daemon keeps the terminal.
  started = performance.now()
  const forced = await supervisor.connect(distro, { intent: 'force' })
  result.forceMs = Math.round(performance.now() - started)
  expect(forced.fullVersion).toBe(deferred.deferredUpdate?.candidateVersion)
  expect(forced.deferredUpdate).toBeNull()
  await runInTerminal(forced, terminal, ':', `terminal kept across Force in ${distro}`)

  // After terminals close, connect can update silently.
  await rpc(forced, 'terminal.close', { terminal })
  await waitForNoLiveTerminals(forced)
  templates.set(key, nextTemplate('n2'))
  started = performance.now()
  const silent = await supervisor.connect(distro)
  result.silentMs = Math.round(performance.now() - started)
  expect(silent.fullVersion).not.toBe(forced.fullVersion)
  expect(silent.deferredUpdate).toBeNull()

  // After reboot, wake the incumbent to prove its empty census.
  await openTerminal(silent)
  visibleWork = false
  const since = statusLog(distro).length
  expect((await wslExe(['--terminate', distro])).code).toBe(0)
  await waitForStatus(distro, since, 'distro-stopped', 30_000)
  visibleWork = true
  templates.set(key, nextTemplate('n3'))
  started = performance.now()
  const rebooted = await supervisor.connect(distro)
  result.rebootUpdateMs = Math.round(performance.now() - started)
  expect(rebooted.fullVersion).not.toBe(silent.fullVersion)
  expect(rebooted.deferredUpdate).toBeNull()
  await rpc(rebooted, 'status.get')
  result.versions = [before, forced, silent, rebooted].map((c) => c.fullVersion)
  result.orcadPid = rebooted.pid
  return result
}

async function launchPhase(distro: string, systemd: boolean): Promise<Receipt> {
  const result: Receipt = {}
  visibleWork = true
  if (!supervisor) {
    throw new Error('supervisor missing')
  }
  // Bash reads only the first login profile; Fedora/Arch ship .bash_profile.
  await guest(
    distro,
    `rc="$HOME/.profile"; for f in "$HOME/.bash_profile" "$HOME/.bash_login"; do ` +
      `if [ -f "$f" ]; then rc="$f"; break; fi; done; ` +
      `grep -q ${LOGIN_ENV_TAG} "$rc" 2>/dev/null || ` +
      `printf 'export SSH_AUTH_SOCK=${LOGIN_ENV_SOCK} # ${LOGIN_ENV_TAG}\\n' >> "$rc"`
  )
  let started = performance.now()
  const connection = await supervisor.connect(distro)
  result.connectMs = Math.round(performance.now() - started)
  result.orcadVersion = connection.fullVersion
  expect(connection.pid).toEqual(expect.any(Number))
  const pid1 = (await guest(distro, 'ps -p 1 -o comm=')).trim()
  result.pid1 = pid1
  if (systemd) {
    expect(pid1).toBe('systemd')
  } else {
    expect(pid1).not.toBe('systemd')
  }
  expect(await runningDistros()).toContain(wslDistroHolderKey(distro))
  result.rpc = await proveRuntimeRpc(connection, distro)

  // Watch exit must classify orcad-exited and trigger recovery.
  let since = statusLog(distro).length
  started = performance.now()
  await guest(distro, `kill -9 ${connection.pid}; true`)
  const recovering = await waitForStatus(distro, since, 'reconnecting', 30_000)
  expect(recovering.reason).toBe('orcad-exited')
  result.killDetectMs = Math.round(performance.now() - started)
  const ready = await waitForStatus(distro, since, 'ready', 180_000)
  result.killRecoverMs = Math.round(performance.now() - started)
  expect(ready.census).not.toBeNull()
  result.census = ready.census
  const relaunched = manager.get(distro)
  if (!relaunched) {
    throw new Error(`${distro} reported ready without a connection`)
  }
  expect(relaunched.pid).toEqual(expect.any(Number))
  expect(relaunched.pid).not.toBe(connection.pid)
  await rpc(relaunched, 'status.get')

  // Distro stop without visible demand must remain stopped.
  visibleWork = false
  since = statusLog(distro).length
  started = performance.now()
  const terminated = await wslExe(['--terminate', distro])
  expect(terminated.code, terminated.output).toBe(0)
  const stopped = await waitForStatus(distro, since, 'distro-stopped', 30_000)
  result.terminateDetectMs = Math.round(performance.now() - started)
  expect(stopped).toMatchObject({ terminals: 'exited', recovering: false })
  expect(await runningDistros()).not.toContain(wslDistroHolderKey(distro))
  if (systemd) {
    await assertWslInteropIntact(PLAIN, `after terminating ${distro}`)
  }

  // Explicit Connect may boot the distro.
  visibleWork = true
  started = performance.now()
  const rebooted = await supervisor.connect(distro)
  result.rebootConnectMs = Math.round(performance.now() - started)
  await rpc(rebooted, 'status.get')
  if (systemd) {
    await assertWslInteropIntact(distro, `after rebooting ${distro}`)
  }
  result.orcadPid = rebooted.pid
  return result
}

async function survivePhase(): Promise<void> {
  const state: LaunchState = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  for (const [key, dir] of Object.entries(state.templates ?? {})) {
    templates.set(key, dir)
  }
  const waitMs = state.launchEndedAtMs + HOLDER_SURVIVAL_MS - Date.now()
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  const secondsSinceLaunchExited = Math.round((Date.now() - state.launchEndedAtMs) / 1000)
  receipt.secondsSinceLaunchExited = secondsSinceLaunchExited
  // Only holders remain after the launching process and its other wsl.exe clients exit.
  const running = await runningDistros()
  for (const { name } of DISTROS) {
    expect(running, `${name} Running ${secondsSinceLaunchExited} s later`).toContain(
      wslDistroHolderKey(name)
    )
  }
  const adopted = await holder.adoptHolders()
  receipt.adopted = adopted
  for (const { name } of DISTROS) {
    expect(adopted).toContainEqual({ distro: name, state: 'live' })
  }
  for (const { name } of DISTROS) {
    let connection = await manager.ensure(name)
    await rpc(connection, 'status.get')
    receipt[`${name}.detachedSession`] = await proveDetachedSession(connection, name)
    receipt[`${name}.census`] = await requestOrcadTerminalCensus(pairedConnection(connection), 0)
    if (connection.pid === null) {
      throw new Error('Missing guest runtime PID')
    }
    receipt[`${name}.chat`] = await proveWslStructuredChat({
      rpc: (method, params) => rpc(connection, method, params),
      guest: (command) => guest(name, command),
      pairing: () => pairedConnection(connection),
      runtimePid: connection.pid,
      reconnect: async (whileDisconnected) => {
        const { localPort, pid } = connection
        await connection.close()
        await whileDisconnected()
        connection = await manager.ensure(name, { localPort })
        expect(connection.pid, 'bridge loss must preserve the guest runtime').toBe(pid)
      }
    })
  }

  // Teardown: bridges closed, holders released, distros terminated.
  await manager.dispose()
  for (const { name } of DISTROS) {
    await expectNoGuestBridges(name)
  }
  const released: Receipt = {}
  receipt.released = released
  for (const { name } of DISTROS) {
    // Mid-exit unreadable command lines are unverifiable; wait for proven holder exit.
    released[name] = await holder.release(name)
    await waitFor(
      `the ${name} holder to exit`,
      async () => ((await holder.holderState(name)) === 'exited' ? true : null),
      10_000,
      250
    )
  }
  // The systemd distro stops while the plain one still runs, so the interop entry is shared.
  if (SYSTEMD) {
    expect((await wslExe(['--terminate', SYSTEMD])).code).toBe(0)
    await assertWslInteropIntact(PLAIN, `after final terminate of ${SYSTEMD}`)
  }
  expect((await wslExe(['--terminate', PLAIN])).code).toBe(0)
  const leftovers = await waitFor(
    'lane wsl.exe processes to exit',
    async () => {
      const rows = await laneWindowsProcesses()
      return rows.length === 0 ? rows : null
    },
    15_000,
    500
  ).catch(async () => laneWindowsProcesses())
  expect(leftovers, 'wsl.exe bridge/holder processes after teardown').toEqual([])
}

describe.runIf(RUN && process.platform === 'win32')('WSL orcad on real WSL2 distros', () => {
  beforeAll(async () => {
    mkdirSync(USER_DATA, { recursive: true })
    mkdirSync(RECEIPT_DIR, { recursive: true })
    installLaneAppEnvironment()
    createLaneManager()
    receipt.wslVersion = (await wslExe(['--version'])).output
  })

  afterAll(async () => {
    await supervisor?.dispose().catch(() => {})
    await manager?.dispose().catch(() => {})
    writeFileSync(join(RECEIPT_DIR, `${PHASE}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
  })

  it.runIf(PHASE === 'launch')(
    'deploys, serves RPC, recovers a killed orcad and reports a terminated distro',
    async () => {
      supervisor = createWslOrcadLivenessSupervisor({
        manager,
        holder,
        hasUserVisibleWork: () => visibleWork
      })
      const pids: LaunchState['orcadPids'] = {}
      for (const { name, systemd } of DISTROS) {
        const result = await launchPhase(name, systemd)
        receipt[name] = result
        pids[name] = typeof result.orcadPid === 'number' ? result.orcadPid : null
      }
      const update = await updatePhase(PLAIN)
      receipt.update = update
      pids[PLAIN] = typeof update.orcadPid === 'number' ? update.orcadPid : null
      // Bridges and watches go; the holders must not.
      await supervisor.dispose()
      supervisor = null
      await manager.dispose()
      for (const { name } of DISTROS) {
        await expectNoGuestBridges(name)
      }
      const state: LaunchState = {
        launchEndedAtMs: Date.now(),
        orcadPids: pids,
        templates: Object.fromEntries(templates)
      }
      writeFileSync(STATE_FILE, JSON.stringify(state))
    },
    (DISTROS.length + 1) * DISTRO_TIMEOUT_MS
  )

  it.runIf(PHASE === 'survive')(
    'keeps every distro held after the launching process exited, then tears down cleanly',
    survivePhase,
    DISTRO_TIMEOUT_MS
  )
})
