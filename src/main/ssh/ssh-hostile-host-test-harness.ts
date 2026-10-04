/**
 * The host-agnostic hostile-host driver: the real client-side relay deploy through a real
 * SshConnection, observed through the ladder's own calls and a {@link HostileHostObserver}.
 * The Docker matrix and the Windows SSH-host lanes both run cells through it.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { expect, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { orcadNodeRuntimeExecutable } from '../../shared/orcad-artifacts'
import type { SshRemoteRuntimeRung, SshTarget } from '../../shared/ssh-types'
import { gcRemoteNodeRuntimeStore } from './remote-node-runtime-store-gc'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import {
  hostileHostCellViolations,
  parseForbiddenToolLog,
  type HostileHostCellCore,
  type RungRefusal
} from './ssh-hostile-host-cells'
import type { HostileHostObserver } from './ssh-hostile-host-observer'
import { retrySshOwnerRecoveryWhileBlocked } from './ssh-owner-recovery-retry'
import { openSshPtyConsumerSession } from './ssh-pty-consumer-session'
import { deployAndLaunchRelay, type RelayDeployResult } from './ssh-relay-deploy'
import { pinnedRelayAddonFiles, pinnedRelayNodePath } from './ssh-relay-pinned-node'
import {
  RelayRuntimeLadderRun,
  RemoteRuntimeUnavailableError
} from './ssh-relay-runtime-resolution'

export type DeployAttempt = {
  deployed: RelayDeployResult | null
  error: unknown
  refusals: RungRefusal[]
  settledRung: SshRemoteRuntimeRung | null
  run: RelayRuntimeLadderRun | null
  /** Every command this deploy sent the host, as the SSH layer received it. */
  commands: string[]
}

/** Input the shell must evaluate to print `expect`; the echoed keystrokes never contain it. */
export type TerminalProbe = { input: string; expect: string }

export const TERMINAL_PROBES = {
  posix: { input: 'echo ORCA_HOSTILE_$((6*7))\r', expect: 'ORCA_HOSTILE_42' },
  // Why through cmd.exe: the same line evaluates whether the relay's PTY shell is cmd or PowerShell.
  windows: { input: 'cmd /d /c set /a 6*7+100000\r', expect: '100042' }
} as const satisfies Record<string, TerminalProbe>

/** Points the app environment at a throwaway userData; returns its cleanup. */
export function installHostileHostAppEnvironment(): () => void {
  const userData = mkdtempSync(join(tmpdir(), 'orca-hostile-hosts-userdata-'))
  const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  setAppEnvironment({
    getPath: (name) => (name === 'userData' ? userData : tmpdir()),
    getAppPath: () => process.cwd(),
    getVersion: () => version,
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  return () => removeTreeSync(userData)
}

export async function connectHostileHost(sshTarget: SshTarget): Promise<SshConnection> {
  const conn = new SshConnection(sshTarget, { onStateChange: () => {} })
  await conn.connect()
  return conn
}

/** One real deploy, with the ladder's own refusal and settle calls as the observation. */
export async function deployOnce(conn: SshConnection): Promise<DeployAttempt> {
  const refused = vi.spyOn(RelayRuntimeLadderRun.prototype, 'refused')
  const settle = vi.spyOn(RelayRuntimeLadderRun.prototype, 'settle')
  const exec = vi.spyOn(SshConnection.prototype, 'exec')
  const attempt: DeployAttempt = {
    deployed: null,
    error: null,
    refusals: [],
    settledRung: null,
    run: null,
    commands: []
  }
  try {
    attempt.deployed = await deployAndLaunchRelay(conn, undefined, 60)
  } catch (error) {
    attempt.error = error
  } finally {
    attempt.refusals = refused.mock.calls.map(([step, reason]) => ({ step, reason }))
    attempt.settledRung = settle.mock.calls.at(-1)?.[0] ?? null
    const context: unknown = settle.mock.contexts.at(-1)
    attempt.run = context instanceof RelayRuntimeLadderRun ? context : null
    attempt.commands = exec.mock.calls.map(([command]) => command)
    refused.mockRestore()
    settle.mockRestore()
    exec.mockRestore()
  }
  return attempt
}

export function deployErrorText(attempt: DeployAttempt): string | null {
  const { error } = attempt
  return error ? (error instanceof Error ? error.message : String(error)) : null
}

export async function assertCell(
  cell: HostileHostCellCore,
  observer: HostileHostObserver,
  attempt: DeployAttempt
): Promise<void> {
  const { error } = attempt
  const violations = hostileHostCellViolations(cell, {
    settledRung: attempt.settledRung,
    target: attempt.run?.facts?.target ?? null,
    unavailableReason: error instanceof RemoteRuntimeUnavailableError ? error.reason : null,
    deployError: deployErrorText(attempt),
    refusals: attempt.refusals,
    forbiddenToolCalls: parseForbiddenToolLog(await observer.readForbiddenToolLog())
  })
  expect(violations, `${cell.id}: ${violations.join('; ')}`).toEqual([])
}

/** Resends the probe this often until the shell evaluates it; typeahead before a prompt can be dropped. */
const TERMINAL_PROBE_RESEND_MS = 15_000

/**
 * Opens a PTY as the session owner and waits for the shell to evaluate what it was sent. Returns
 * the multiplexer's disposer: until called, the session keeps answering relay keepalives, as the
 * app does, so the relay never reaps it as silent while the connection is still up.
 */
export async function assertTerminalEchoes(
  deployed: RelayDeployResult,
  clientInstanceId: string,
  probe: TerminalProbe
): Promise<() => void> {
  const mux = new SshChannelMultiplexer(deployed.transport)
  let keepOpen = false
  try {
    // Why retry: the first connect's owner stays held for its grace period, and the app retries too.
    await retrySshOwnerRecoveryWhileBlocked(
      () =>
        openSshPtyConsumerSession(mux, {
          clientInstanceId,
          expectedServerBuildId: deployed.serverBuildId
        }),
      { isCurrent: () => true, onClosed: () => () => {} }
    )
    const output = new Map<string, string>()
    mux.onNotificationByMethod('pty.data', (params) => {
      if (typeof params.id === 'string' && typeof params.data === 'string') {
        output.set(params.id, (output.get(params.id) ?? '') + params.data)
      }
    })
    const spawned: unknown = await mux.request('pty.spawn', { cols: 80, rows: 24 })
    const id =
      spawned && typeof spawned === 'object' && 'id' in spawned && typeof spawned.id === 'string'
        ? spawned.id
        : ''
    expect(id).not.toBe('')
    // Why 90s: a first Windows PowerShell start under ConPTY can take tens of seconds on CI.
    const deadline = Date.now() + 90_000
    let nextSendAt = 0
    while (!(output.get(id) ?? '').includes(probe.expect) && Date.now() < deadline) {
      if (Date.now() >= nextSendAt) {
        mux.notify('pty.data', { id, data: probe.input })
        nextSendAt = Date.now() + TERMINAL_PROBE_RESEND_MS
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(output.get(id) ?? '').toContain(probe.expect)
    await mux.request('pty.shutdown', { id })
    keepOpen = true
    return () => mux.dispose()
  } finally {
    if (!keepOpen) {
      mux.dispose()
    }
  }
}

export type PinnedRuntimeLayout = { nodePath: string; runtimeDir: string; storeDir: string }

export function pinnedRuntimeLayout(
  deployed: RelayDeployResult,
  target: NodeRuntimeTarget
): PinnedRuntimeLayout {
  if (!deployed.hostPlatform || !deployed.remoteRelayDir) {
    throw new Error('A pinned deploy must report its host and relay directory')
  }
  // Remote paths join with `/` on every host flavor, Windows included.
  const nodePath = pinnedRelayNodePath(deployed.hostPlatform, deployed.remoteRelayDir, target)
  let runtimeDir = nodePath
  const depth = orcadNodeRuntimeExecutable(target).split('/').length
  for (let level = 0; level < depth; level++) {
    runtimeDir = posix.dirname(runtimeDir)
  }
  return { nodePath, runtimeDir, storeDir: posix.dirname(runtimeDir) }
}

/**
 * Plants an older and a newer idle runtime beside the live one and collects with no client pin:
 * only the reference and the running relay can keep the live runtime.
 */
async function assertGcKeepsInUseRuntime(
  conn: SshConnection,
  observer: HostileHostObserver,
  deployed: RelayDeployResult,
  layout: PinnedRuntimeLayout
): Promise<void> {
  const older = `node-${'a'.repeat(64)}`
  const newer = `node-${'b'.repeat(64)}`
  await observer.plantIdleRuntime(layout.storeDir, older, 'old')
  await observer.plantIdleRuntime(layout.storeDir, newer, 'new')
  const { hostPlatform, remoteHome } = deployed
  if (!hostPlatform || !remoteHome) {
    throw new Error('A pinned deploy must report its host and home')
  }
  let state = 'skipped'
  // Why retry: the deploy's own background GC may still hold the store lock.
  for (let attempt = 0; attempt < 20 && state !== 'collected'; attempt++) {
    const result = await gcRemoteNodeRuntimeStore(conn, hostPlatform, remoteHome, {
      currentPins: []
    })
    state = result.state
    if (state !== 'collected') {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
  }
  expect(state).toBe('collected')
  expect(await observer.isFile(layout.nodePath)).toBe(true)
  expect(await observer.exists(`${layout.storeDir}/${newer}`)).toBe(true)
  expect(await observer.exists(`${layout.storeDir}/${older}`)).toBe(false)
}

export type LaunchedCellRun = {
  cell: HostileHostCellCore
  observer: HostileHostObserver
  sshTarget: SshTarget
  terminal: TerminalProbe
  first: DeployAttempt
  firstConn: SshConnection
  /** Extra per-deploy checks, e.g. the Windows command audit; `uploaded` is the first deploy. */
  inspectDeploy?: (attempt: DeployAttempt, uploaded: boolean) => void
}

export type LaunchedCellEvidence = { nodePath: string; nodeSha256: string }

export async function exerciseLaunchedCell(run: LaunchedCellRun): Promise<LaunchedCellEvidence> {
  const { cell, observer, sshTarget, terminal, first, firstConn } = run
  if (cell.expect.outcome !== 'launched' || !first.deployed || !first.run) {
    throw new Error(`${cell.id} did not launch a relay`)
  }
  // Rung B runs a compat runtime, which is what its store dir, sha and addon slot are keyed by.
  const runtime = cell.expect.runtime ?? cell.expect.target
  expect(first.run.selfTest).toBe('passed')
  expect(first.run.runtimeTransfer).toBe('uploaded')
  run.inspectDeploy?.(first, true)
  const layout = pinnedRuntimeLayout(first.deployed, runtime)
  const { executableSha256 } = pinnedNodeRuntimeAsset(runtime)
  expect(posix.basename(layout.runtimeDir)).toBe(`node-${executableSha256}`)
  const nodeSha256 = await observer.fileSha256(layout.nodePath)
  expect(nodeSha256).toBe(executableSha256)
  // Every slot file the relay loads, the Windows bundled ConPTY pair included, landed beside it.
  for (const file of pinnedRelayAddonFiles(runtime)) {
    expect(await observer.isFile(`${first.deployed.remoteRelayDir}/${file}`), file).toBe(true)
  }
  // Why one id for both connects: the app reconnects as the same client instance.
  const clientInstanceId = randomUUID()
  const closeFirstSession = await assertTerminalEchoes(first.deployed, clientInstanceId, terminal)
  try {
    await assertGcKeepsInUseRuntime(firstConn, observer, first.deployed, layout)
  } finally {
    closeFirstSession()
  }
  const before = await observer.fileStamp(layout.nodePath)
  await firstConn.disconnect()

  const secondConn = await connectHostileHost(sshTarget)
  try {
    const second = await deployOnce(secondConn)
    await assertCell(cell, observer, second)
    expect(second.run?.runtimeTransfer).toBe('cached')
    run.inspectDeploy?.(second, false)
    expect(await observer.fileStamp(layout.nodePath)).toBe(before)
    if (!second.deployed) {
      throw new Error(`${cell.id} did not relaunch on the second connect`)
    }
    const closeSecondSession = await assertTerminalEchoes(
      second.deployed,
      clientInstanceId,
      terminal
    )
    closeSecondSession()
  } finally {
    await secondConn.disconnect()
  }
  return { nodePath: layout.nodePath, nodeSha256 }
}
