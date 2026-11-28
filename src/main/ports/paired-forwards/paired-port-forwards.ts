import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { requireLoopbackPortForwardDialHost } from '../../../shared/workspace/ports/port-forward-loopback-host'
import {
  PortForwardTornDownError,
  SshPortForwardManager
} from '../../ssh/port-forwarding/ssh-port-forward'
import {
  assertLoopbackPortFree,
  registerForwardPortHolder
} from '../../ssh/port-forwarding/forward-local-port-choice'
import { forwardKey, type ForwardMapping } from '../../ssh/port-forwarding/saved-port-forward-list'
import {
  dropPairedPortForwardSession,
  forwardsPortFor,
  ownPairedPortForward,
  type SessionForwardRemoval
} from './paired-port-forward-sessions'
import {
  forgetSavedPairedPortForwards,
  recordRestoredPortForwardMove,
  savedForwardLocalPorts,
  savedPairedPortForwardEnvironmentIds,
  savedPairedPortForwards,
  savePairedPortForwards,
  setPairedPortForwardStore,
  type PairedPortForwardStore
} from './paired-port-forward-saved'
import { runtimeHostKeyFingerprint } from '../../ipc/runtime-environments/catalog/runtime-environment-host-key'
import { serializePortForwardChange } from '../../ipc/ssh/ssh-managed-port-forward-restore'
import { PairedPortForwardProvider } from './paired-port-forward-provider'
import { addPairedForwardOnFirstFreePort } from './paired-port-forward-free-port'
import type { PairedPortForwardTunnel } from './paired-port-forward-tunnel'
import {
  disposeAllPairedForwardTunnels,
  disposePairedForwardTunnel,
  openPairedForwardTunnel,
  pairedForwardTeardownStamp,
  pairedForwardTunnel,
  pairedForwardTunnelEnvironmentIds,
  tearDownPairedForwardTunnel
} from './paired-port-forward-tunnels'
import { assertSocksClientOwnerLookup } from '../../browser/network/tunnels/remote-browser-socks-client-owner'

type PairedPortForwardsDeps = {
  resolveConnection: (environmentId: string) => Promise<PairedRuntimeConnection>
  onChanged: (environmentId: string) => void
  /** Saved forwards by environment; absent where nothing persists them. */
  saved?: PairedPortForwardStore
}

let deps: PairedPortForwardsDeps | null = null
const manager = new SshPortForwardManager<PairedPortForwardTunnel>(
  { onForwardClosed: (entry) => deps?.onChanged(entry.connectionId) },
  [new PairedPortForwardProvider()]
)
registerForwardPortHolder(() => manager.heldLocalPorts())

export function configurePairedPortForwards(next: PairedPortForwardsDeps): void {
  deps = next
  setPairedPortForwardStore(next.saved ?? null)
}

type ForwardSpec = ForwardMapping & { environmentId: string; label?: string }

export function listPairedPortForwards(environmentId?: string): PortForwardEntry[] {
  return manager.listForwards(environmentId)
}

/** Servers with forwards here or saved, including one whose first forward is still starting. */
export function pairedPortForwardEnvironmentIds(): string[] {
  return [
    ...new Set([
      ...pairedForwardTunnelEnvironmentIds(),
      ...manager.listForwards().map((entry) => entry.connectionId),
      ...savedPairedPortForwardEnvironmentIds()
    ])
  ]
}

export function addPairedPortForward(spec: ForwardSpec): Promise<PortForwardEntry> {
  const remoteHost = requireLoopbackPortForwardDialHost(spec.remoteHost)
  return serializePortForwardChange(forwardChangeKey(spec.environmentId), async () => {
    const hostKey = await requireForwardableServer(spec.environmentId)
    // Held before any await, so a removal racing this start finds the server and closes it.
    const tunnel = tunnelFor(spec.environmentId, hostKey)
    await assertLoopbackPortFree(spec.localPort).catch(retireIdleTunnelAfter(spec.environmentId))
    const entry = await manager
      .addForward(
        spec.environmentId,
        tunnel,
        spec.localPort,
        remoteHost,
        spec.remotePort,
        spec.label
      )
      .catch(retireIdleTunnelAfter(spec.environmentId))
    save(spec.environmentId, hostKey)
    deps?.onChanged(spec.environmentId)
    return entry
  })
}

export function updatePairedPortForward(
  spec: ForwardSpec & { id: string }
): Promise<PortForwardEntry> {
  const remoteHost = requireLoopbackPortForwardDialHost(spec.remoteHost)
  return serializePortForwardChange(forwardChangeKey(spec.environmentId), async () => {
    const hostKey = await requireForwardableServer(spec.environmentId)
    const current = manager.listForwards(spec.environmentId).find((entry) => entry.id === spec.id)
    if (!current) {
      throw new Error(`Port forward "${spec.id}" not found`)
    }
    // Held before any await, so a disconnect during the probe cancels the edit.
    const tunnel = tunnelFor(spec.environmentId, hostKey)
    // The forward being edited answers on its own port, and rebinds both loopbacks there itself.
    if (current.localPort !== spec.localPort) {
      await assertLoopbackPortFree(spec.localPort)
    }
    try {
      const entry = await manager.updateForward(
        spec.id,
        tunnel,
        spec.localPort,
        remoteHost,
        spec.remotePort,
        spec.label
      )
      dropPairedPortForwardSession(spec.id)
      save(spec.environmentId, hostKey, [current])
      return entry
    } catch (error) {
      // A disconnect closed every forward; saving that would erase what reconnecting restores.
      if (!(error instanceof PortForwardTornDownError)) {
        save(spec.environmentId, hostKey)
      }
      throw error
    } finally {
      deps?.onChanged(spec.environmentId)
    }
  })
}

/** `only`: a session's removal, decided in the server's queue after every change queued before it. */
export async function removePairedPortForward(id: string, only?: SessionForwardRemoval) {
  const environmentId =
    only?.environmentId ?? manager.listForwards().find((entry) => entry.id === id)?.connectionId
  if (!environmentId) {
    return false
  }
  return serializePortForwardChange(forwardChangeKey(environmentId), async () => {
    if (only && !only.when()) {
      return false
    }
    const hostKey = pairedForwardTunnel(environmentId)?.hostKeyFingerprint
    const removed = await manager.removeForwardAndWait(id)
    dropPairedPortForwardSession(id)
    retireIdleTunnel(environmentId)
    save(environmentId, hostKey, removed ? [removed] : [])
    deps?.onChanged(environmentId)
    return removed !== null
  })
}

/** The forward for a server localhost port, started on the same port number here when that is free. */
export function ensurePairedPortForward(args: {
  environmentId: string
  remotePort: number
  label?: string
  /** The running session (one Mobile Emulator attach) whose own forward this is: never shared or
   *  saved, on a port the OS picks (the server's helper port number is one this computer's own
   *  simulators start on), closed when the session ends. */
  session?: string
}): Promise<{ entry: PortForwardEntry; created: boolean }> {
  return serializePortForwardChange(forwardChangeKey(args.environmentId), async () => {
    const hostKey = await requireForwardableServer(args.environmentId)
    // Every paired forward dials the server's own loopback, so its port and owner name the service.
    const existing = manager
      .listForwards(args.environmentId)
      .find((entry) => forwardsPortFor(entry, args.remotePort, args.session))
    if (existing) {
      return { entry: existing, created: false }
    }
    const tunnel = tunnelFor(args.environmentId, hostKey)
    const entry = await addPairedForwardOnFirstFreePort(manager, tunnel, {
      localPort: args.session ? 0 : args.remotePort,
      remoteHost: 'localhost',
      remotePort: args.remotePort,
      label: args.label
    }).catch(retireIdleTunnelAfter(args.environmentId))
    // A session that ended while this bound opens nothing.
    if (args.session && !ownPairedPortForward(entry.id, args.session, args.environmentId)) {
      await manager.removeForwardAndWait(entry.id)
      retireIdleTunnel(args.environmentId)
      throw new Error('This emulator session has ended.')
    }
    save(args.environmentId, hostKey)
    deps?.onChanged(args.environmentId)
    return { entry, created: true }
  })
}

/** Starts a reconnected server's saved forwards that aren't listening here, each on its own port when
 *  free and otherwise the next free one. Never dials: the tunnel opens on the first connection. */
export function restorePairedPortForwards(environmentId: string): Promise<void> {
  if (!savedPairedPortForwards(environmentId)?.forwards.length) {
    return Promise.resolve()
  }
  return serializePortForwardChange(forwardChangeKey(environmentId), async () => {
    // Refuses a server removed or disconnected since, and retires forwards of a replaced pairing.
    const hostKey = await requireForwardableServer(environmentId)
    const live = new Set(manager.listForwards(environmentId).map(forwardKey))
    const saved = savedPairedPortForwards(environmentId)?.forwards ?? []
    const pending = saved.filter((forward) => !live.has(forwardKey(forward)))
    if (pending.length === 0) {
      return
    }
    const tunnel = tunnelFor(environmentId, hostKey)
    const moved = new Map<ForwardMapping, number>()
    // Built once per pass; each forward may take back only its own saved port.
    const reserved = savedForwardLocalPorts()
    for (const forward of pending) {
      reserved.delete(forward.localPort)
      const entry = await addPairedForwardOnFirstFreePort(manager, tunnel, forward, reserved).catch(
        (error: unknown) => {
          if (!(error instanceof PortForwardTornDownError)) {
            console.warn(`[port-forwards] Could not restore forward :${forward.localPort}:`, error)
          }
          return null
        }
      )
      reserved.add(forward.localPort)
      // Cancelled: nothing is saved or announced, so the next restore starts from the saved ports.
      if (tunnel.isDisposed()) {
        return
      }
      if (entry && entry.localPort !== forward.localPort) {
        moved.set(forward, entry.localPort)
      }
    }
    retireIdleTunnel(environmentId)
    // A moved forward is saved on its new port, so the address the person is told stays put.
    save(environmentId, hostKey, [...moved.keys()])
    moved.forEach((localPort, from) =>
      recordRestoredPortForwardMove(environmentId, from, localPort)
    )
    deps?.onChanged(environmentId)
  }).catch((error: unknown) => {
    if (!(error instanceof PortForwardTornDownError)) {
      console.warn(`[port-forwards] Could not restore forwards for ${environmentId}:`, error)
    }
  })
}

/** A person disconnected the server: its forwards stop listening here until it reconnects. */
export function closePairedPortForwards(environmentId: string): Promise<void> {
  const release = tearDownPairedForwardTunnel(environmentId)
  // Queued behind changes already underway, so none of them leaves a listener after it.
  return serializePortForwardChange(forwardChangeKey(environmentId), () =>
    stopForwards(environmentId).finally(release)
  )
}

/** A person removed the pairing: its forwards stop and are never restored. */
export function forgetPairedPortForwards(environmentId: string): Promise<void> {
  forgetSavedPairedPortForwards(environmentId)
  const release = tearDownPairedForwardTunnel(environmentId)
  return serializePortForwardChange(forwardChangeKey(environmentId), async () => {
    // A restore that was already running may have saved them again.
    forgetSavedPairedPortForwards(environmentId)
    await stopForwards(environmentId).finally(release)
  })
}

async function stopForwards(environmentId: string): Promise<void> {
  disposePairedForwardTunnel(environmentId)
  const forwards = manager.listForwards(environmentId)
  await manager.removeAllForwards(environmentId)
  forwards.forEach((entry) => dropPairedPortForwardSession(entry.id))
  if (forwards.length > 0) {
    deps?.onChanged(environmentId)
  }
}

/** The server's transport was replaced; forwards keep listening and redial on their next connection. */
export function resetPairedPortForwardTunnel(environmentId: string): void {
  pairedForwardTunnel(environmentId)?.reset(new Error('Runtime environment transport was retired'))
}

export async function closeAllPairedPortForwards(): Promise<void> {
  disposeAllPairedForwardTunnels()
  await manager.closeAll()
}

/** Refuses a removed or disconnected server, or a computer that can't check who connects, before any
 *  port probe or listener. Returns its host key digest, after retiring forwards made for another
 *  machine paired under the same entry. */
async function requireForwardableServer(environmentId: string): Promise<string> {
  const teardown = pairedForwardTeardownStamp(environmentId)
  await assertSocksClientOwnerLookup('port forward')
  const connection = await requireConnectionResolver()(environmentId)
  if (pairedForwardTeardownStamp(environmentId) !== teardown) {
    throw new PortForwardTornDownError()
  }
  const hostKey = runtimeHostKeyFingerprint(connection.hostPublicKeyB64)
  if ((savedPairedPortForwards(environmentId)?.hostKeyFingerprint ?? hostKey) !== hostKey) {
    forgetSavedPairedPortForwards(environmentId)
  }
  if ((pairedForwardTunnel(environmentId)?.hostKeyFingerprint ?? hostKey) !== hostKey) {
    await stopForwards(environmentId)
  }
  return hostKey
}

function tunnelFor(environmentId: string, hostKey: string): PairedPortForwardTunnel {
  return openPairedForwardTunnel(environmentId, hostKey, requireConnectionResolver())
}

function requireConnectionResolver(): PairedPortForwardsDeps['resolveConnection'] {
  if (!deps) {
    throw new Error('Port forwarding is not ready')
  }
  return deps.resolveConnection
}

function save(
  environmentId: string,
  hostKey: string | undefined,
  dropped?: readonly ForwardMapping[]
): void {
  savePairedPortForwards(environmentId, hostKey, manager.listForwards(environmentId), dropped)
}

function retireIdleTunnel(environmentId: string): void {
  if (manager.listForwards(environmentId).length === 0) {
    disposePairedForwardTunnel(environmentId)
  }
}

/** A failed first forward leaves no tunnel behind for a server with nothing forwarded. */
function retireIdleTunnelAfter(environmentId: string): (error: unknown) => never {
  return (error) => {
    retireIdleTunnel(environmentId)
    throw error
  }
}

function forwardChangeKey(environmentId: string): string {
  return `runtime:${environmentId}`
}
