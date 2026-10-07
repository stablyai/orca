/**
 * Lets the target's provider hand a PTY to an earlier build's relay that still runs it.
 *
 * Every per-PTY caller resolves the target's one registered provider, so routing lives here rather
 * than at each call site: a reattach the current relay answered with
 * {@link SshPtyHeldByPreviousRelayError} is retried through the old relay, and once that pane is
 * served there, every later operation on its id goes to the same relay.
 */
import { SshPtyHeldByPreviousRelayError } from './ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import type { SshPtyProvider } from './ssh-pty-provider'
import type { SshPtyAttachResult } from './ssh-pty-session-reattach'
import type { PtySpawnOptions, PtySpawnResult } from './types'
import { writeRefused } from '../../shared/pty-write-settlement'

export type SshPtyLegacyRelayRouting = {
  /** The served route for a held PTY, or null when no older relay holds it. */
  attach: (appPtyId: string) => Promise<{ provider: SshPtyProvider; release: () => void } | null>
  providerFor: (appPtyId: string) => SshPtyProvider | undefined
  /** Runs a request for a served PTY on its route, keeping the route open until it settles. */
  track: <T>(
    appPtyId: string,
    request: (provider: SshPtyProvider) => Promise<T>
  ) => Promise<T> | undefined
  /** Stops a PTY an older relay holds through a short-lived route; see SshLegacyRelayRouter. */
  stopHeld: (
    appPtyId: string,
    stop: (provider: SshPtyProvider) => Promise<void>
  ) => Promise<{ stopped: true } | { stopped: false; reachable: boolean }>
  /** Exits the older relays report for served PTYs. */
  onExit: (listener: Parameters<SshPtyProvider['onExit']>[0]) => () => void
  servedProviders: () => SshPtyProvider[]
  dispose: () => void
}

const routingByProvider = new WeakMap<SshPtyProvider, SshPtyLegacyRelayRouting>()
/**
 * App PTY ids an older relay may run but no route serves. The current relay drops input for an id it
 * never minted without a word, so writes to these are refused instead of reported as delivered.
 */
const heldByProvider = new WeakMap<SshPtyProvider, Set<string>>()

function recordHeld(provider: SshPtyProvider, appPtyId: string, held: boolean): void {
  const ids = heldByProvider.get(provider)
  if (held) {
    ids?.add(appPtyId)
  } else {
    ids?.delete(appPtyId)
  }
}

/**
 * The reconnect path's counterpart to the delegated spawn: a reattach the current relay disowned is
 * retried through the older relay that holds it. Null when no older relay serves the PTY.
 */
export async function attachHeldPtyThroughPreviousRelay(
  provider: SshPtyProvider,
  appPtyId: string,
  expected?: { paneKey?: string; tabId?: string }
): Promise<SshPtyAttachResult | null> {
  const served = await routingByProvider.get(provider)?.attach(appPtyId)
  recordHeld(provider, appPtyId, !served)
  if (!served) {
    return null
  }
  try {
    return await served.provider.attachForReconnect(appPtyId, expected)
  } catch (error) {
    served.release()
    recordHeld(provider, appPtyId, true)
    throw error
  }
}

/** A stop whose bridge dropped mid-request may or may not have landed: unverifiable, not failed. */
async function unverifiableIfBridgeLost<T>(stop: Promise<T>, relayPtyId: string): Promise<T> {
  try {
    return await stop
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'DISPOSED' || code === 'CONNECTION_LOST') {
      throw new SshPtyHeldByPreviousRelayError(relayPtyId)
    }
    throw error
  }
}

export function installSshPtyLegacyRelayDelegation(
  provider: SshPtyProvider,
  routing: SshPtyLegacyRelayRouting
): void {
  // Why: a second install would wrap the wrappers and route through two routing tables.
  if (routingByProvider.has(provider)) {
    throw new Error('ssh_pty_legacy_relay_routing_already_installed')
  }
  routingByProvider.set(provider, routing)
  const held = new Set<string>()
  heldByProvider.set(provider, held)
  const own = {
    dispose: provider.dispose.bind(provider),
    spawn: provider.spawn.bind(provider),
    attach: provider.attach.bind(provider),
    attachForReconnect: provider.attachForReconnect.bind(provider),
    shutdown: provider.shutdown.bind(provider),
    onExit: provider.onExit,
    pauseProducer: provider.pauseProducer.bind(provider),
    resumeProducer: provider.resumeProducer.bind(provider),
    listProcesses: provider.listProcesses,
    write: provider.write,
    writeWithSettlement: provider.writeWithSettlement,
    resize: provider.resize,
    sendSignal: provider.sendSignal,
    getCwd: provider.getCwd,
    getInitialCwd: provider.getInitialCwd,
    clearBuffer: provider.clearBuffer,
    resetInputModes: provider.resetInputModes,
    closeStartupQueryAuthority: provider.closeStartupQueryAuthority,
    acknowledgeDataEvent: provider.acknowledgeDataEvent,
    hasChildProcesses: provider.hasChildProcesses,
    getForegroundProcess: provider.getForegroundProcess,
    inspectProcess: provider.inspectProcess,
    hasPty: provider.hasPty,
    getAppliedSize: provider.getAppliedSize,
    serialize: provider.serialize,
    providesAgentSessionOwnerListings: provider.providesAgentSessionOwnerListings.bind(provider)
  }
  // Why normalized: the reconnect path names a PTY in relay form, panes in app form.
  const routed = (id: string): SshPtyProvider | undefined => {
    try {
      return routing.providerFor(toAppSshPtyId(provider.getConnectionId(), id))
    } catch {
      return undefined
    }
  }

  provider.dispose = () => {
    routing.dispose()
    own.dispose()
  }

  provider.spawn = async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
    try {
      return await own.spawn(opts)
    } catch (error) {
      if (!(error instanceof SshPtyHeldByPreviousRelayError) || !opts.sessionId) {
        throw error
      }
      const served = await routing.attach(opts.sessionId)
      recordHeld(provider, opts.sessionId, !served)
      if (!served) {
        throw error
      }
      try {
        return await served.provider.spawn(opts)
      } catch (legacyError) {
        served.release()
        recordHeld(provider, opts.sessionId, true)
        throw legacyError
      }
    }
  }
  provider.attach = (id) => routed(id)?.attach(id) ?? own.attach(id)
  provider.attachForReconnect = (id, expected, recovery) =>
    routed(id)?.attachForReconnect(id, expected, recovery) ??
    own.attachForReconnect(id, expected, recovery)
  // Why the stop finds its route first: the current relay answers a stop for an id it never minted
  // as done, so a held PTY sent there was reported stopped while its shell kept running.
  provider.shutdown = async (id, opts) => {
    const appPtyId = toAppSshPtyId(provider.getConnectionId(), id)
    const relayPtyId = toRelaySshPtyId(provider.getConnectionId(), id)
    const stopOnOldRelay = (legacy: SshPtyProvider): Promise<void> => legacy.shutdown(id, opts)
    const servedStop = routing.track(appPtyId, stopOnOldRelay)
    if (servedStop) {
      return await unverifiableIfBridgeLost(servedStop, relayPtyId)
    }
    if (own.hasPty(appPtyId) || own.hasPty(relayPtyId)) {
      return await own.shutdown(id, opts)
    }
    // A PTY no pane resumed this connection: a short-lived route stops it on the relay that runs it.
    const held = await unverifiableIfBridgeLost(
      routing.stopHeld(appPtyId, stopOnOldRelay),
      relayPtyId
    )
    if (held.stopped) {
      return
    }
    if (!held.reachable || isHeldUnserved(id)) {
      throw new SshPtyHeldByPreviousRelayError(relayPtyId)
    }
    return await own.shutdown(id, opts)
  }
  // Why merged: a stop waits for the exit of the PTY it stopped, which an older relay reports.
  provider.onExit = (callback) => {
    const stopOwn = own.onExit(callback)
    const stopRouted = routing.onExit(callback)
    return () => {
      stopOwn()
      stopRouted()
    }
  }
  provider.pauseProducer = (id) => (routed(id) ?? own).pauseProducer(id)
  provider.resumeProducer = (id) => (routed(id) ?? own).resumeProducer(id)
  const isHeldUnserved = (id: string): boolean => {
    try {
      return held.has(toAppSshPtyId(provider.getConnectionId(), id))
    } catch {
      return false
    }
  }
  provider.write = (id, data) =>
    routed(id)?.write(id, data) ?? (isHeldUnserved(id) ? false : own.write(id, data))
  provider.writeWithSettlement = (id, data) =>
    routed(id)?.writeWithSettlement(id, data) ??
    (isHeldUnserved(id)
      ? Promise.resolve(writeRefused('endpoint_awaiting_recovery'))
      : own.writeWithSettlement(id, data))
  provider.resize = (id, cols, rows) => (routed(id) ?? own).resize(id, cols, rows)
  provider.sendSignal = (id, signal) =>
    routed(id)?.sendSignal(id, signal) ?? own.sendSignal(id, signal)
  provider.getCwd = (id) => routed(id)?.getCwd(id) ?? own.getCwd(id)
  provider.getInitialCwd = (id) => routed(id)?.getInitialCwd(id) ?? own.getInitialCwd(id)
  provider.clearBuffer = (id) => routed(id)?.clearBuffer(id) ?? own.clearBuffer(id)
  provider.resetInputModes = (id) => routed(id)?.resetInputModes(id) ?? own.resetInputModes(id)
  provider.closeStartupQueryAuthority = (id) =>
    routed(id)?.closeStartupQueryAuthority(id) ?? own.closeStartupQueryAuthority(id)
  provider.acknowledgeDataEvent = (id, charCount) =>
    (routed(id) ?? own).acknowledgeDataEvent(id, charCount)
  provider.hasChildProcesses = (id) =>
    routed(id)?.hasChildProcesses(id) ?? own.hasChildProcesses(id)
  provider.getForegroundProcess = (id) =>
    routed(id)?.getForegroundProcess(id) ?? own.getForegroundProcess(id)
  provider.inspectProcess = (id, options) =>
    routed(id)?.inspectProcess(id, options) ?? own.inspectProcess(id, options)
  provider.hasPty = (id) => routed(id) !== undefined || own.hasPty(id)
  provider.getAppliedSize = (id) => (routed(id) ?? own).getAppliedSize(id)
  provider.providesAgentSessionOwnerListings = (id) =>
    (routed(id) ?? own).providesAgentSessionOwnerListings(id)
  // Why not routed: revive replays onto this relay and would respawn a PTY the older one still runs.
  provider.serialize = (ids) => own.serialize(ids.filter((id) => routed(id) === undefined))
  // Why merged, and rejecting when an older relay cannot answer: a served PTY missing from the
  // listing reads as exited to inventory, and a relay we could not ask proves nothing.
  provider.listProcesses = async (options) => {
    const [current, ...previous] = await Promise.all([
      own.listProcesses(options),
      ...routing
        .servedProviders()
        .map((legacy) =>
          legacy
            .listProcesses(options)
            .then((rows) => rows.filter((row) => routed(row.id) === legacy))
        )
    ])
    return [...current, ...previous.flat()]
  }
}
