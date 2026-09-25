import { setRemoteRuntimeTunnelDialer } from '../../shared/remote-runtime-tunnel-dialer'
import { TailcatTunnelService } from './tailcat-tunnel-service'

let service: TailcatTunnelService | null = null

/** One tunnel service per process, shared by the RPC server, the IPC layer, the CLI and remote dials. */
export function getTailcatTunnelService(
  userDataPath: string,
  options: { logf?: (message: string) => void } = {}
): TailcatTunnelService {
  if (!service) {
    service = new TailcatTunnelService({
      userDataPath,
      logf: options.logf ?? ((message) => console.log(`[tunnel] ${message}`))
    })
  }
  return service
}

/** Lets a client process (the CLI) reach tunnel-shared hosts; no server is ever started here. */
export function registerTailcatTunnelDialer(
  userDataPath: string,
  options: { logf?: (message: string) => void } = {}
): void {
  setRemoteRuntimeTunnelDialer(getTailcatTunnelService(userDataPath, options).dial)
}

export async function disposeTailcatTunnel(): Promise<void> {
  const current = service
  service = null
  setRemoteRuntimeTunnelDialer(null)
  await current?.stop()
}
