/**
 * Every SSH target's legacy relay bridge, and the one seam the rest of main calls.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type { EventProps } from '../../../shared/telemetry-events'
import type {
  LegacyRelayBridgeAttachResult,
  LegacyRelayBridgeCloseResult,
  LegacyRelayBridgedPane
} from '../../../shared/legacy-relay-bridge-contract'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { SshConnection } from '../ssh-connection'
import { waitForSentinel } from './ssh-relay-sentinel'
import { probeRelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { isWindowsRemoteHost } from '../ssh-remote-platform'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { LegacyRelayClient } from './legacy-relay-client'
import { createLegacyRelayCliServer } from './legacy-relay-cli-server'
import { listLegacyRelayEndpoints, type LegacyRelayEndpoint } from './legacy-relay-endpoints'
import { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'
import { LegacyRelayHiddenOutput } from './legacy-relay-hidden-output'
import { LegacyRelayPaneStops } from './legacy-relay-pane-stops'
import { reportDailyRelayActivity, watchDailyRelayActivity } from './legacy-relay-daily-activity'
import {
  bridgeableLeasesByRelayId,
  isBridgeableLease,
  leasedAppPtyIds
} from './legacy-relay-bridge-leases'

/** How long a connect waits for the first look at its relays before publishing the host. */
const START_BUDGET_MS = 20_000
/** How long an attach waits for a target whose connection is still coming up. */
const CONNECTION_WAIT_MS = 20_000

type TerminalsBucket = EventProps<'ssh_host_server_legacy_relay_bridge'>['terminals']
type ReportPhase = EventProps<'ssh_host_server_legacy_relay_bridge'>['phase']

export type LegacyRelayBridgeHost = {
  leases: (targetId: string) => SshRemotePtyLease[]
  retireLease: (targetId: string, relayPtyId: string) => void
  connection: (targetId: string) => SshConnection | null
  onPanesChanged: (panes: LegacyRelayBridgedPane[]) => void
  onData: (ptyId: string, data: string) => void
  onReplay: (ptyId: string, replay: string) => void
  onExit: (ptyId: string, code: number) => void
  report: (targetId: string, phase: ReportPhase, terminals: number) => void
  /** Absent: relay-era `orca` commands are refused, as before this host served them. */
  remoteCli?: {
    runtime: () => OrcaRuntimeService | null
    /** The per-host "Allow this host's orca CLI to control Orca" switch. */
    allowed: (targetId: string) => boolean
  }
}

let host: LegacyRelayBridgeHost | null = null
let hiddenOutput: LegacyRelayHiddenOutput | null = null
const bridges = new Map<string, LegacyRelayTargetBridge>()
/**
 * Panes a hung-up bridge served, held `unverifiable` until the target's next bridge lists its own
 * or the leases go: a hang-up is loss of contact, not exit (docs/reference/ssh-execution-boundary.md).
 */
const heldPanes = new Map<string, LegacyRelayBridgedPane[]>()
const paneStops = new Map<string, LegacyRelayPaneStops>()

export function installLegacyRelayBridge(next: LegacyRelayBridgeHost | null): void {
  for (const bridge of bridges.values()) {
    bridge.dispose()
  }
  bridges.clear()
  heldPanes.clear()
  paneStops.forEach((stops) => stops.dispose())
  paneStops.clear()
  watchDailyRelayActivity(next, () =>
    [...bridges].map(([id, bridge]) => [id, bridge.livePaneCount()] as const)
  )
  host = next
  hiddenOutput = next
    ? new LegacyRelayHiddenOutput({
        onData: next.onData,
        onReplay: next.onReplay,
        reread: rereadLegacyRelayScreen
      })
    : null
}

export function terminalsBucket(count: number): TerminalsBucket {
  if (count <= 0) {
    return 'none'
  }
  if (count === 1) {
    return '1'
  }
  if (count < 5) {
    return '2_4'
  }
  return count < 10 ? '5_9' : '10_plus'
}

function hasBridgeableLeases(targetId: string): boolean {
  return host?.leases(targetId).some(isBridgeableLease) ?? false
}

function bridgeFor(targetId: string): LegacyRelayTargetBridge | null {
  const existing = bridges.get(targetId)
  if (existing || !host) {
    return existing ?? null
  }
  const installed = host
  const clientInstanceId = `orca-legacy-relay-bridge:${targetId}`
  const connection = (): SshConnection => {
    const conn = installed.connection(targetId)
    if (!conn) {
      throw new Error('ssh_connection_unavailable')
    }
    return conn
  }
  const remoteCli = installed.remoteCli
  const cliServer = remoteCli
    ? createLegacyRelayCliServer({
        targetId,
        runtime: remoteCli.runtime,
        remoteCliControl: () => remoteCli.allowed(targetId),
        livePane: (paneKey) => bridge.livePaneForKey(paneKey)
      })
    : undefined
  const bridge: LegacyRelayTargetBridge = new LegacyRelayTargetBridge({
    targetId,
    leases: () => installed.leases(targetId),
    retireLease: (relayPtyId) => installed.retireLease(targetId, relayPtyId),
    listEndpoints: async (signal) => {
      const conn = installed.connection(targetId)
      return conn ? listLegacyRelayEndpoints(conn, targetId, signal) : { kind: 'unverifiable' }
    },
    openClient: (endpoint, resume) =>
      LegacyRelayClient.open({
        clientInstanceId,
        resume,
        cliServer,
        openTransport: async () =>
          waitForSentinel(
            await connection().exec(endpoint.connectCommand ?? '', {
              wrapCommand: endpoint.wrapCommand
            })
          )
      }),
    endpointExited: (endpoint) => posixEndpointExited(connection(), endpoint),
    onPanesChanged: () => {
      // A running bridge's own listing answers for its target; a disposed one's does not.
      if (bridges.get(targetId) === bridge) {
        heldPanes.delete(targetId)
        stopsFor(targetId).flush(bridge)
        reportDailyRelayActivity(targetId, bridge.livePaneCount(), installed.report)
      }
      installed.onPanesChanged(legacyRelayBridgedPanes())
    },
    onData: (ptyId, data) => hiddenOutput?.onData(ptyId, data),
    onExit: (ptyId, code) => {
      hiddenOutput?.forget(ptyId)
      installed.onExit(ptyId, code)
    },
    onTerminalExited: () => installed.report(targetId, 'terminal_exited', 0)
  })
  bridges.set(targetId, bridge)
  return bridge
}

function stopsFor(targetId: string): LegacyRelayPaneStops {
  const existing = paneStops.get(targetId)
  if (existing) {
    return existing
  }
  const created = new LegacyRelayPaneStops(targetId, () => host?.leases(targetId) ?? [])
  paneStops.set(targetId, created)
  return created
}

/** A dead socket is the one failed open that proves its relay gone; Windows pipes never are. */
async function posixEndpointExited(
  conn: SshConnection,
  endpoint: LegacyRelayEndpoint
): Promise<boolean> {
  if (isWindowsRemoteHost(endpoint.host) || !endpoint.nodePath) {
    return false
  }
  const incumbent = await probeRelayEndpointIncumbent(
    conn,
    endpoint.host,
    endpoint.nodePath,
    endpoint.endpoint
  )
  return incumbent.verdict === 'exited'
}

/**
 * Called once a connect reaches the host's managed server: looks at the relays this target left,
 * so the panes they still run are known before the renderer remounts them on the new server.
 */
export async function startLegacyRelayBridge(targetId: string): Promise<void> {
  if (!hasBridgeableLeases(targetId)) {
    // Leases retired while hung up publish nothing themselves; this connect is the next answer.
    releaseHeldPanes(targetId)
    return
  }
  const bridge = bridgeFor(targetId)
  if (!bridge) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    bridge.refresh().catch((error: unknown) => {
      console.warn(`[ssh] Legacy relay bridge could not look at ${targetId}:`, error)
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, START_BUDGET_MS)
    })
  ])
  clearTimeout(timer)
  const live = bridge.livePaneCount()
  if (live > 0) {
    host?.report(targetId, 'connected', live)
  }
}

export function stopLegacyRelayBridge(targetId: string): void {
  const bridge = bridges.get(targetId)
  if (bridge) {
    const held = bridge.snapshot().map((pane) => ({ ...pane, state: 'unverifiable' as const }))
    if (held.length > 0) {
      heldPanes.set(targetId, held)
    }
    bridges.delete(targetId)
    // Disposing publishes the list, now with the held panes instead of the bridge's.
    bridge.dispose()
  }
}

/** The target and its leases are gone, so nothing it served is held any longer. */
export function forgetLegacyRelayTarget(targetId: string): void {
  stopLegacyRelayBridge(targetId)
  releaseHeldPanes(targetId)
  paneStops.get(targetId)?.dispose()
  paneStops.delete(targetId)
}

function releaseHeldPanes(targetId: string): void {
  if (heldPanes.delete(targetId)) {
    host?.onPanesChanged(legacyRelayBridgedPanes())
  }
}

export function legacyRelayBridgedPanes(): LegacyRelayBridgedPane[] {
  return [
    ...[...bridges.values()].flatMap((bridge) => bridge.snapshot()),
    ...[...heldPanes].flatMap(([targetId, panes]) => stillLeased(targetId, panes))
  ]
}

function stillLeased(targetId: string, panes: LegacyRelayBridgedPane[]): LegacyRelayBridgedPane[] {
  const leased = bridgeableLeasesByRelayId(host?.leases(targetId) ?? [])
  return panes.filter((pane) => leased.has(parseAppSshPtyId(pane.ptyId)?.relayPtyId ?? ''))
}

export async function attachLegacyRelayPane(
  ptyId: string,
  replayInStream = false
): Promise<LegacyRelayBridgeAttachResult> {
  const targetId = parseAppSshPtyId(ptyId)?.connectionId
  if (!targetId || !host || !hasBridgeableLeases(targetId)) {
    return { status: 'not-bridged' }
  }
  const bridge = bridgeFor(targetId)
  if (!bridge) {
    return { status: 'not-bridged' }
  }
  // A pane can mount before its host's connect finishes; the bridge keeps retrying until it can ask.
  if (!(await waitForConnection(targetId))) {
    void bridge.refresh()
    return { status: 'unverifiable' }
  }
  const result = await bridge.attach(ptyId, (replay) => {
    hiddenOutput?.screenSent(ptyId)
    // In output order, so a reattach's clear never erases what the relay printed after this screen.
    if (replayInStream) {
      host?.onReplay(ptyId, replay)
    }
  })
  return replayInStream && result.status === 'attached' ? { ...result, replay: '' } : result
}

/** Re-reads a live pane's screen through the same attach a reconnect uses. */
async function rereadLegacyRelayScreen(
  ptyId: string,
  atSnapshot: (replay: string) => void
): Promise<void> {
  const bridge = bridgeForPty(ptyId)
  const result = await bridge?.attach(ptyId, atSnapshot)
  if (result?.status === 'attached') {
    // The attach counted a viewer; this re-read is not one.
    bridge?.detach(ptyId, result.acquisitionId)
  }
}

async function waitForConnection(targetId: string): Promise<boolean> {
  const deadline = Date.now() + CONNECTION_WAIT_MS
  while (!host?.connection(targetId)) {
    if (Date.now() >= deadline || !host) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return true
}

function bridgeForPty(ptyId: string): LegacyRelayTargetBridge | undefined {
  const targetId = parseAppSshPtyId(ptyId)?.connectionId
  return targetId ? bridges.get(targetId) : undefined
}

export function writeLegacyRelayPane(ptyId: string, data: string): void {
  bridgeForPty(ptyId)?.write(ptyId, data)
}

export function resizeLegacyRelayPane(ptyId: string, cols: number, rows: number): void {
  bridgeForPty(ptyId)?.resize(ptyId, cols, rows)
}

export function setLegacyRelayPaneOutputPaused(ptyId: string, paused: boolean): void {
  hiddenOutput?.setPaused(ptyId, paused)
}

/** Whether this PTY is an older relay's terminal the bridge serves, so only the bridge stops it. */
export function isLegacyRelayBridgedPty(ptyId: string): boolean {
  const targetId = parseAppSshPtyId(ptyId)?.connectionId
  return Boolean(targetId && host && leasedAppPtyIds(targetId, host.leases(targetId)).has(ptyId))
}

/** Its tab closed: the relay stops the shell, or is asked once it can be reached. */
export async function closeLegacyRelayPane(ptyId: string): Promise<LegacyRelayBridgeCloseResult> {
  const targetId = parseAppSshPtyId(ptyId)?.connectionId
  if (!targetId || !host || !hasBridgeableLeases(targetId)) {
    return { status: 'not-bridged' }
  }
  // Disconnected: recorded now, and the target's next connect lists the relay and sends the stop.
  return stopsFor(targetId).stop(ptyId, host.connection(targetId) ? bridgeFor(targetId) : null)
}

export function detachLegacyRelayPane(ptyId: string, acquisitionId: number): void {
  bridgeForPty(ptyId)?.detach(ptyId, acquisitionId)
}
