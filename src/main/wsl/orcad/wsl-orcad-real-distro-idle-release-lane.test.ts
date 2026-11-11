// WSL via orcad, phase 3 of the real-distro lane (R40 / E17): after the survive phase's teardown,
// a fresh orcad with a short idle timeout keeps its distro while a terminal is live, then
// idle-exits once it is closed and the holder lets the distro stop with no release call.
// .github/workflows/wsl-orcad-e2e.yml runs it.
//
// Run: ORCA_RUN_WSL_ORCAD_LANE=1 pnpm test <this file>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { setAppEnvironment } from '../../../shared/app-environment'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { ORCAD_E2E_IDLE_TIMEOUT_ENV } from '../../../shared/orcad-idle-exit'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../../shared/remote-runtime/pairing/pairing'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { readConfirmedRunningWslDistros } from '../discovery/wsl-background-distro-gate'
import { readWindowsProcessTableFresh } from '../../windows/windows-process-table'

import { createWslDistroHolder } from '../discovery/wsl-distro-holder'
import type { WslDistroHolder } from '../discovery/wsl-distro-holder-types'
import { WSL_DISTRO_HOLDER_POLL_SECONDS } from '../discovery/wsl-distro-holder-command'
import { wslDistroHolderKey } from '../discovery/wsl-distro-holder-record'
import { WslOrcadConnectionManager } from './wsl-orcad-connection'
import type { WslOrcadConnection } from './wsl-orcad-connection-types'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'

import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'

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
let holder: WslDistroHolder
let manager: WslOrcadConnectionManager

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
  manager = new WslOrcadConnectionManager({
    holder,
    listen: listenWslOrcadStdioBridge,
    verifyIdentity: verifyWslOrcadIdentity,
    createTransport: (target) => createWslOrcadHostTransport({ target }),
    deployAndLaunch: (distro, options) =>
      deployAndLaunchWslOrcad(distro, {
        ...options,
        templateDir: templates.get(wslDistroHolderKey(distro))
      })
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

function pairedConnectionOf(connection: WslOrcadConnection) {
  const offer = parsePairingCode(connection.pairingOffer)
  if (!offer) {
    throw new Error(`Unparseable pairing offer for ${connection.distro}`)
  }
  return pairedRuntimeConnectionFromOffer(offer)
}

function resultOf<T>(
  method: string,
  response: Awaited<ReturnType<typeof sendRemoteRuntimeRequestOnSocket<T>>>
): T {
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

async function rpc<T>(connection: WslOrcadConnection, method: string, params?: unknown) {
  const response = await sendRemoteRuntimeRequestOnSocket<T>(
    pairedConnectionOf(connection),
    method,
    params,
    30_000,
    undefined,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    undefined,
    undefined
  )
  return resultOf(method, response)
}

async function plainRunning(): Promise<boolean> {
  const running = await readConfirmedRunningWslDistros()
  if (running.status !== 'confirmed') {
    throw new Error('wsl --list --running was unavailable')
  }
  return running.distros.some((d) => wslDistroHolderKey(d) === wslDistroHolderKey(PLAIN))
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
  let connection = await manager.ensure(PLAIN)
  await rpc(connection, 'status.get')
  const repoPath = (await guest('cd "$HOME/wsl-orcad-lane-repo" && pwd')).trim()
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })

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
  // Nothing here called release: the holder ended itself.
  expect(await holder.holderState(PLAIN)).toBe('exited')
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

  // Real idle timeout, holder poll and WSL's own stop on a live distro.
  it(
    'keeps a distro with a live terminal, then lets it stop once orcad idle-exits',
    idleReleasePhase,
    RELEASE_BUDGET_MS + 2 * HELD_WITH_TERMINAL_MS + 6 * 60_000
  )
})
