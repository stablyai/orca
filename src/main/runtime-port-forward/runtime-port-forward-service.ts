import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest
} from '../../shared/runtime-port-forwards'
import type { RuntimePortForwardManager } from './runtime-port-forward-manager'

let installed: RuntimePortForwardManager | null = null

/** Main-process singleton; registered once by the runtime port forward IPC module. */
export function installRuntimePortForwardManager(manager: RuntimePortForwardManager): void {
  installed?.dispose()
  installed = manager
}

export function getRuntimePortForwardManager(): RuntimePortForwardManager | null {
  return installed
}

/** For main-process features (SSH access, share) that need a host port on this computer's loopback. */
export async function openRuntimePortForward(
  request: RuntimePortForwardOpenRequest
): Promise<
  | { ok: true; localPort: number; forward: RuntimePortForward; close: () => void }
  | { ok: false; code: string; message: string }
> {
  if (!installed) {
    return { ok: false, code: 'tunnel_failed', message: 'Port forwarding is not ready yet.' }
  }
  const manager = installed
  const result = await manager.open(request)
  if (!result.ok) {
    return result
  }
  return {
    ok: true,
    localPort: result.forward.localPort,
    forward: result.forward,
    close: () => manager.close(result.forward.id)
  }
}
