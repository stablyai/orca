/**
 * The managed tunnel's transport choice, made each time a tunnel starts: the SSH local forward
 * wherever the host allows it, and the stdio bridge where its sshd refuses forwarding.
 */
import { OrcadStdioBridgePortForwardProvider } from './orcad-stdio-bridge-provider'
import { rememberOrcadTunnelTransport } from './orcad-tunnel-transport-memo'
import type { SshConnection } from './ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import { probeTcpForwarding, type TcpForwardingVerdict } from './ssh-tcp-forwarding-probe'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'

type OrcadManagedTunnelTransportDependencies = {
  forwards: SshPortForwardProvider[]
  stdio: SshPortForwardProvider
  probe: (conn: SshConnection, port: number) => Promise<TcpForwardingVerdict>
}

export class OrcadManagedTunnelTransportProvider implements SshPortForwardProvider {
  constructor(
    private readonly dependencies: OrcadManagedTunnelTransportDependencies = {
      forwards: [new Ssh2PortForwardProvider(), new SystemSshPortForwardProvider()],
      stdio: new OrcadStdioBridgePortForwardProvider(),
      probe: probeTcpForwarding
    }
  ) {}

  canHandle(conn: SshConnection): boolean {
    return this.dependencies.forwards.some((provider) => provider.canHandle(conn))
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const { forwards, stdio, probe } = this.dependencies
    // Why only on refusal: an unverifiable answer keeps the forward, as before this transport.
    if ((await probe(conn, options.remotePort)) === 'refused' && stdio.canHandle(conn)) {
      const started = await stdio.start(conn, options)
      rememberOrcadTunnelTransport(options.connectionId, 'stdio_bridge')
      return started
    }
    const forward = forwards.find((provider) => provider.canHandle(conn))
    if (!forward) {
      throw new Error('SSH connection is not established')
    }
    const started = await forward.start(conn, options)
    rememberOrcadTunnelTransport(options.connectionId, 'tcp_forward')
    return started
  }
}
