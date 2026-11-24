import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { loopbackPortForwardDialHost } from '../../../shared/workspace/ports/port-forward-loopback-host'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  addForwardOnFreeLocalPort,
  assertLoopbackPortFree
} from '../../ssh/port-forwarding/forward-local-port-choice'
import { serializePortForwardChange } from '../../ipc/ssh/ssh-managed-port-forward-restore'
import { holdsIpv6Loopback, PairedPortForwardProvider } from './paired-port-forward-provider'
import { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

type PairedPortForwardsDeps = {
  resolveConnection: (environmentId: string) => Promise<PairedRuntimeConnection>
  onChanged: (environmentId: string) => void
}

let deps: PairedPortForwardsDeps | null = null
const tunnels = new Map<string, PairedPortForwardTunnel>()
const manager = new SshPortForwardManager<PairedPortForwardTunnel>(
  { onForwardClosed: (entry) => deps?.onChanged(entry.connectionId) },
  [new PairedPortForwardProvider()]
)

export function configurePairedPortForwards(next: PairedPortForwardsDeps): void {
  deps = next
}

type ForwardSpec = {
  environmentId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export function listPairedPortForwards(environmentId?: string): PortForwardEntry[] {
  return manager.listForwards(environmentId)
}

/** Servers with forwards here, including one whose first forward is still starting. */
export function pairedPortForwardEnvironmentIds(): string[] {
  return [
    ...new Set([...tunnels.keys(), ...manager.listForwards().map((entry) => entry.connectionId)])
  ]
}

export function addPairedPortForward(spec: ForwardSpec): Promise<PortForwardEntry> {
  const remoteHost = requireLoopbackRemoteHost(spec.remoteHost)
  return serializePortForwardChange(forwardChangeKey(spec.environmentId), async () => {
    await requireForwardableServer(spec.environmentId)
    // Held before any await, so a removal racing this start finds the server and closes it.
    const tunnel = tunnelFor(spec.environmentId)
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
    deps?.onChanged(spec.environmentId)
    return entry
  })
}

export function updatePairedPortForward(
  spec: ForwardSpec & { id: string }
): Promise<PortForwardEntry> {
  const remoteHost = requireLoopbackRemoteHost(spec.remoteHost)
  return serializePortForwardChange(forwardChangeKey(spec.environmentId), async () => {
    const current = manager.listForwards(spec.environmentId).find((entry) => entry.id === spec.id)
    if (!current) {
      throw new Error(`Port forward "${spec.id}" not found`)
    }
    // The forward being edited answers on its own port, and rebinds both loopbacks there itself.
    if (current.localPort !== spec.localPort) {
      await assertLoopbackPortFree(spec.localPort)
    }
    try {
      return await manager.updateForward(
        spec.id,
        tunnelFor(spec.environmentId),
        spec.localPort,
        remoteHost,
        spec.remotePort,
        spec.label
      )
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
    const removed = await manager.removeForwardAndWait(id)
    retireIdleTunnel(environmentId)
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
    // Every paired forward dials the server's own loopback, so its port alone names the service.
    const existing = manager
      .listForwards(args.environmentId)
      .find((entry) => entry.remotePort === args.remotePort)
    if (existing) {
      return { entry: existing, created: false }
    }
    await requireForwardableServer(args.environmentId)
    const tunnel = tunnelFor(args.environmentId)
    const add = (localPort: number) =>
      manager.addForward(
        args.environmentId,
        tunnel,
        localPort,
        'localhost',
        args.remotePort,
        args.label
      )
    const entry = await addForwardOnFreeLocalPort(
      args.remotePort,
      add,
      (id) => manager.removeForwardAndWait(id),
      holdsIpv6Loopback(process.platform)
    ).catch(retireIdleTunnelAfter(args.environmentId))
    deps?.onChanged(args.environmentId)
    return { entry, created: true }
  })
}

/** A person removed or disconnected the server: its forwards stop listening here. Queued behind
 *  changes already underway, so none of them starts a listener after it. */
export function closePairedPortForwards(environmentId: string): Promise<void> {
  return serializePortForwardChange(forwardChangeKey(environmentId), async () => {
    const tunnel = tunnels.get(environmentId)
    tunnels.delete(environmentId)
    tunnel?.dispose()
    const hadForwards = manager.listForwards(environmentId).length > 0
    await manager.removeAllForwards(environmentId)
    if (hadForwards) {
      deps?.onChanged(environmentId)
    }
  })
}

/** The server's transport was replaced; forwards keep listening and redial on their next connection. */
export function resetPairedPortForwardTunnel(environmentId: string): void {
  tunnels.get(environmentId)?.reset(new Error('Runtime environment transport was retired'))
}

export async function closeAllPairedPortForwards(): Promise<void> {
  for (const tunnel of tunnels.values()) {
    tunnel.dispose()
  }
  tunnels.clear()
  await manager.closeAll()
}

/** Refuses a server that is removed or disconnected, before any listener binds for it. */
async function requireForwardableServer(environmentId: string): Promise<void> {
  const resolveConnection = deps?.resolveConnection
  if (!resolveConnection) {
    throw new Error('Port forwarding is not ready')
  }
  await resolveConnection(environmentId)
}

function tunnelFor(environmentId: string): PairedPortForwardTunnel {
  const existing = tunnels.get(environmentId)
  if (existing) {
    return existing
  }
  const resolveConnection = deps?.resolveConnection
  if (!resolveConnection) {
    throw new Error('Port forwarding is not ready')
  }
  const tunnel = new PairedPortForwardTunnel(environmentId, () => resolveConnection(environmentId))
  tunnels.set(environmentId, tunnel)
  return tunnel
}

function retireIdleTunnel(environmentId: string): void {
  if (manager.listForwards(environmentId).length > 0) {
    return
  }
  tunnels.get(environmentId)?.dispose()
  tunnels.delete(environmentId)
}

/** A failed first forward leaves no tunnel behind for a server with nothing forwarded. */
function retireIdleTunnelAfter(environmentId: string): (error: unknown) => never {
  return (error) => {
    retireIdleTunnel(environmentId)
    throw error
  }
}

function requireLoopbackRemoteHost(remoteHost: string): string {
  const host = loopbackPortForwardDialHost(remoteHost)
  if (!host) {
    throw new Error('Only localhost ports on a paired server can be forwarded.')
  }
  return host
}

function forwardChangeKey(environmentId: string): string {
  return `runtime:${environmentId}`
}
