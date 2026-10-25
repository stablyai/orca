// Lost channels drop their sockets but keep the listener; tunnel reconnect logic owns recovery.
import { OrcadStdioBridgeUnavailableError } from '../../orcad/orcad-host-unavailable'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  checkOrcadStdioBridge,
  openOrcadStdioBridgeChannel,
  resolveOrcadStdioBridge,
  type OrcadStdioBridge
} from '../../ssh/orcad-stdio-bridge'
import { listenOrcadStdioBridge } from './orcad-stdio-bridge-listener'
import { sshOrcadHostTransport } from '../../ssh/orcad-ssh-host-transport'
import type { RemoteCommandChannel } from '../install/remote-install-transport'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'

export type OrcadStdioBridgeDependencies = {
  resolveBridge: (conn: OrcadHostTransport, port: number) => Promise<OrcadStdioBridge>
  checkBridge: (conn: OrcadHostTransport, bridge: OrcadStdioBridge) => Promise<unknown>
  openChannel: (conn: OrcadHostTransport, bridge: OrcadStdioBridge) => Promise<RemoteCommandChannel>
}

export const ORCAD_STDIO_BRIDGE_DEPENDENCIES: OrcadStdioBridgeDependencies = {
  resolveBridge: resolveOrcadStdioBridge,
  checkBridge: checkOrcadStdioBridge,
  openChannel: openOrcadStdioBridgeChannel
}

export class OrcadStdioBridgePortForwardProvider implements SshPortForwardProvider {
  constructor(
    private readonly dependencies: OrcadStdioBridgeDependencies = ORCAD_STDIO_BRIDGE_DEPENDENCIES
  ) {}

  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null || conn.usesSystemSshTransport()
  }

  start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    return startOrcadStdioBridge(sshOrcadHostTransport(conn), options, this.dependencies)
  }
}

export async function startOrcadStdioBridge(
  host: OrcadHostTransport,
  options: PortForwardStartOptions,
  deps: OrcadStdioBridgeDependencies
): Promise<StartedPortForward> {
  let bridge: Promise<OrcadStdioBridge> | null = null
  // Retry failed bridge resolution on the next socket.
  const resolveBridge = (): Promise<OrcadStdioBridge> => {
    bridge ??= deps.resolveBridge(host, options.remotePort).catch((error: unknown) => {
      bridge = null
      throw error
    })
    return bridge
  }
  try {
    await deps.checkBridge(host, await resolveBridge())
  } catch (error) {
    if (error instanceof OrcadStdioBridgeUnavailableError) {
      throw error
    }
    // Lost contact does not prove bridge absence; let new sockets resolve it again.
    console.warn('[ssh] Orca stdio bridge check was unverifiable:', error)
  }
  return listenOrcadStdioBridge(options, async () => {
    const resolved = await resolveBridge()
    return { channel: await deps.openChannel(host, resolved), mode: resolved.mode }
  })
}
