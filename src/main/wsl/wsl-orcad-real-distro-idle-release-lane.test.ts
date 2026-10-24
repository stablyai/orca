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
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { WSL_DISTRO_HOLDER_POLL_SECONDS } from './wsl-distro-holder-command'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { WslOrcadConnectionManager, type WslOrcadConnection } from './wsl-orcad-connection'
import { defaultWslOrcadEnvironmentId, deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'

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
    deployAndLaunch: (distro, options) =>
      deployAndLaunchWslOrcad(distro, {
        ...options,
        templateDir: templates.get(wslDistroHolderKey(distro))
      })
  })
}

function guest(command: string): Promise<string> {
  const target = {
    kind: 'wsl' as const,
    id: defaultWslOrcadEnvironmentId(PLAIN),
    distro: PLAIN,
    label: PLAIN
  }
  return execCommand(createWslOrcadHostTransport({ target }), command, { timeoutMs: 60_000 })
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

async function waitFor<T>(
  what: string,
  read: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) {
      return value
    }
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function idleReleasePhase(): Promise<void> {
  process.env[ORCAD_E2E_IDLE_TIMEOUT_ENV] = String(IDLE_TIMEOUT_MS)
  receipt.vmBeforeLaunchKiB = await vmWorkingSetKiB()
  let connection = await manager.ensure(PLAIN)
  await rpc(connection, 'status.get')
  const repoPath = (await guest('cd "$HOME/wsl-orcad-lane-repo" && pwd')).trim()
  const created = await rpc<{ terminal: { handle: string } }>(connection, 'terminal.create', {
    worktree: `path:${repoPath}`
  })
  receipt.held = { ...(await guestMemory()), vmKiB: await vmWorkingSetKiB() }

  // No client, but a live terminal: orcad must not idle-exit and the holder must stay.
  await manager.dispose()
  await new Promise((resolve) => setTimeout(resolve, HELD_WITH_TERMINAL_MS))
  expect(await plainRunning(), 'a live terminal keeps the distro').toBe(true)
  expect(await holder.holderState(PLAIN)).toBe('live')

  createManager()
  connection = await manager.ensure(PLAIN)
  expect(connection.pid, 'the same orcad served the reconnect').not.toBeNull()
  await rpc(connection, 'terminal.close', { terminal: created.terminal.handle })
  await manager.dispose()
  const closedAt = performance.now()

  await waitFor(
    `${PLAIN} to stop after orcad idle-exits`,
    async () => ((await plainRunning()) ? null : true),
    RELEASE_BUDGET_MS
  ).catch(async (error: unknown) => {
    // The distro is still running, so this boots nothing: record what kept it.
    receipt.stillRunning = await guest(
      'ls -la "$HOME/.orca/wsl-holder-release" 2>&1; ps -eo pid,args | grep -v grep | grep -E "orca|node" || true'
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

  it(
    'keeps a distro with a live terminal, then lets it stop once orcad idle-exits',
    idleReleasePhase,
    RELEASE_BUDGET_MS + HELD_WITH_TERMINAL_MS + 6 * 60_000
  )
})
