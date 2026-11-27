import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

/** Each paired server's forward tunnel, shared by all of its forwards. */
const tunnels = new Map<string, PairedPortForwardTunnel>()
// Stamped by each disconnect or removal; a change that resolved its server across one is cancelled.
const teardowns = new Map<string, number>()
let teardownCount = 0

export function pairedForwardTunnel(environmentId: string): PairedPortForwardTunnel | undefined {
  return tunnels.get(environmentId)
}

export function pairedForwardTunnelEnvironmentIds(): string[] {
  return [...tunnels.keys()]
}

export function pairedForwardTeardownStamp(environmentId: string): number | undefined {
  return teardowns.get(environmentId)
}

export function openPairedForwardTunnel(
  environmentId: string,
  hostKey: string,
  resolveConnection: (environmentId: string) => Promise<PairedRuntimeConnection>
): PairedPortForwardTunnel {
  const existing = tunnels.get(environmentId)
  if (existing) {
    return existing
  }
  const tunnel = new PairedPortForwardTunnel(environmentId, hostKey, () =>
    resolveConnection(environmentId)
  )
  tunnels.set(environmentId, tunnel)
  return tunnel
}

export function disposePairedForwardTunnel(environmentId: string): void {
  tunnels.get(environmentId)?.dispose()
  tunnels.delete(environmentId)
}

/** Fences the server at once, so a restore or start underway binds nothing more and dials nothing.
 *  Call the returned release from the teardown's own serialized change, once earlier work drained. */
export function tearDownPairedForwardTunnel(environmentId: string): () => void {
  const stamp = ++teardownCount
  teardowns.set(environmentId, stamp)
  disposePairedForwardTunnel(environmentId)
  return () => {
    if (teardowns.get(environmentId) === stamp) {
      teardowns.delete(environmentId)
    }
  }
}

export function disposeAllPairedForwardTunnels(): void {
  for (const tunnel of tunnels.values()) {
    tunnel.dispose()
  }
  tunnels.clear()
}
