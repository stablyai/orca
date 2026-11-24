import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { requireLoopbackPortForwardDialHost } from '../../../shared/workspace/ports/port-forward-loopback-host'
import {
  PortForwardTornDownError,
  SshPortForwardManager
} from '../../ssh/port-forwarding/ssh-port-forward'
import {
  addForwardOnFreeLocalPort,
  assertLoopbackPortFree
} from '../../ssh/port-forwarding/forward-local-port-choice'
import { forwardKey, type ForwardMapping } from '../../ssh/port-forwarding/saved-port-forward-list'
import {
  forgetSavedPairedPortForwards,
  recordRestoredPortForwardMove,
  reservedPairedPortForwardPorts,
  savedPairedPortForwardEnvironmentIds,
  savedPairedPortForwards,
  savePairedPortForwards,
  setPairedPortForwardStore,
  type PairedPortForwardStore
} from './paired-port-forward-saved'
import { runtimeHostKeyFingerprint } from '../../ipc/runtime-environments/catalog/runtime-environment-host-key'
import { serializePortForwardChange } from '../../ipc/ssh/ssh-managed-port-forward-restore'
import { holdsIpv6Loopback, PairedPortForwardProvider } from './paired-port-forward-provider'
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

export async function removePairedPortForward(id: string): Promise<boolean> {
  const environmentId = manager.listForwards().find((entry) => entry.id === id)?.connectionId
  if (!environmentId) {
    return false
  }
  return serializePortForwardChange(forwardChangeKey(environmentId), async () => {
    const hostKey = pairedForwardTunnel(environmentId)?.hostKeyFingerprint
    const removed = await manager.removeForwardAndWait(id)
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
}): Promise<{ entry: PortForwardEntry; created: boolean }> {
  return serializePortForwardChange(forwardChangeKey(args.environmentId), async () => {
    const hostKey = await requireForwardableServer(args.environmentId)
    // Every paired forward dials the server's own loopback, so its port alone names the service.
    const existing = manager
      .listForwards(args.environmentId)
      .find((entry) => entry.remotePort === args.remotePort)
    if (existing) {
      return { entry: existing, created: false }
    }
    const tunnel = tunnelFor(args.environmentId, hostKey)
    const entry = await addOnFirstFreePort(tunnel, {
      localPort: args.remotePort,
      remoteHost: 'localhost',
      remotePort: args.remotePort,
      label: args.label
    }).catch(retireIdleTunnelAfter(args.environmentId))
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
    const reserved = reservedPairedPortForwardPorts()
    for (const forward of pending) {
      reserved.delete(forward.localPort)
      const entry = await addOnFirstFreePort(tunnel, forward, reserved).catch((error: unknown) => {
        if (!(error instanceof PortForwardTornDownError)) {
          console.warn(`[port-forwards] Could not restore forward :${forward.localPort}:`, error)
        }
        return null
      })
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

/** The forward on `preferred.localPort` when nothing here answers there, else the next free port. */
function addOnFirstFreePort(
  tunnel: PairedPortForwardTunnel,
  preferred: ForwardMapping & { label?: string },
  reserved: ReadonlySet<number> = reservedPairedPortForwardPorts()
): Promise<PortForwardEntry> {
  return addForwardOnFreeLocalPort({
    remotePort: preferred.remotePort,
    preferredLocalPort: preferred.localPort,
    add: (localPort) =>
      manager.addForward(
        tunnel.environmentId,
        tunnel,
        localPort,
        preferred.remoteHost,
        preferred.remotePort,
        preferred.label
      ),
    remove: (id) => manager.removeForwardAndWait(id),
    holdsIpv6Loopback: holdsIpv6Loopback(process.platform),
    reservedLocalPorts: reserved,
    heldLocalPorts: () => manager.heldLocalPorts()
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
  const hadForwards = manager.listForwards(environmentId).length > 0
  await manager.removeAllForwards(environmentId)
  if (hadForwards) {
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

/** Refuses a server that is removed or disconnected, before any listener binds for it. Returns its
 *  host key's digest, after retiring forwards made for another machine paired under the same entry. */
async function requireForwardableServer(environmentId: string): Promise<string> {
  const resolveConnection = requireConnectionResolver()
  const teardown = pairedForwardTeardownStamp(environmentId)
  const connection = await resolveConnection(environmentId)
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
  if (manager.listForwards(environmentId).length > 0) {
    return
  }
  disposePairedForwardTunnel(environmentId)
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
