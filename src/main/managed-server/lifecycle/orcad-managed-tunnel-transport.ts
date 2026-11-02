/**
 * The managed tunnel's transport choice, made each time a tunnel starts: the SSH local forward
 * wherever the host allows it, and the stdio bridge where its sshd refuses forwarding.
 */
import { OrcadStdioBridgePortForwardProvider } from './orcad-stdio-bridge-provider'
import { rememberOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type { SshConnection } from '../../ssh/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import {
  checkForwardChannel,
  probeTcpForwarding,
  type TcpForwardingVerdict
} from '../../ssh/ssh-tcp-forwarding-probe'
import { Ssh2PortForwardProvider } from '../../ssh/port-forwarding/ssh2-port-forward-provider'
import {
  SystemSshPortForwardProvider,
  systemSshForwardBuildArgsOptions
} from '../../ssh/port-forwarding/system-ssh-port-forward-provider'
import {
  buildSystemSshPortForwardArgs,
  reserveLocalForwardPort
} from '../../ssh/system-transport/system-ssh-forward-process'

type OrcadManagedTunnelTransportDependencies = {
  forwards: SshPortForwardProvider[]
  stdio: SshPortForwardProvider
  probe: (conn: SshConnection, port: number) => Promise<TcpForwardingVerdict>
  checkForward: (forward: StartedPortForward) => Promise<TcpForwardingVerdict>
  /** Frees the persisted local port (an orphaned `ssh -L` may hold it) before the bridge binds. */
  reserveLocalPort: (conn: SshConnection, options: PortForwardStartOptions) => Promise<unknown>
}

export class OrcadManagedTunnelTransportProvider implements SshPortForwardProvider {
  // Why per transport generation: a reconnect may route through a different sshd.
  private readonly refusedGenerations = new WeakMap<SshConnection, number>()

  constructor(
    private readonly dependencies: OrcadManagedTunnelTransportDependencies = {
      forwards: [new Ssh2PortForwardProvider(), new SystemSshPortForwardProvider()],
      stdio: new OrcadStdioBridgePortForwardProvider(),
      probe: probeTcpForwarding,
      checkForward: checkForwardChannel,
      reserveLocalPort: reserveBridgeLocalPort
    }
  ) {}

  canHandle(conn: SshConnection): boolean {
    return this.dependencies.forwards.some((provider) => provider.canHandle(conn))
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const { forwards, probe, checkForward } = this.dependencies
    // Why captured: a refusal answered by a transport that reconnected meanwhile is not the new one's.
    const generation = conn.getConnectGeneration()
    if (this.refusedGenerations.get(conn) === generation) {
      return this.startBridge(conn, options, generation)
    }
    // Why only on refusal: an unverifiable answer keeps the forward, as before this transport.
    if ((await probe(conn, options.remotePort)) === 'refused') {
      return this.startBridge(conn, options, generation)
    }
    const forward = forwards.find((provider) => provider.canHandle(conn))
    if (!forward) {
      throw new Error('SSH connection is not established')
    }
    // Why: the manager only hears an exit once it holds the forward, which it does not mid-check.
    const exits: string[] = []
    const started = await forward.start(conn, {
      ...options,
      onUnexpectedClose: (entry, reason) => {
        exits.push(reason.kind === 'unexpected-exit' ? (reason.detail ?? 'exited') : 'closed')
        options.onUnexpectedClose?.(entry, reason)
      }
    })
    // Why: system SSH's listener is up before sshd is asked for a channel, so it proves nothing.
    const verdict = await checkForward(started)
    if (verdict === 'refused') {
      await started.close()
      return this.startBridge(conn, options, generation)
    }
    if (exits.length > 0) {
      throw new Error(`The managed Orca server tunnel closed while it was checked: ${exits[0]}`)
    }
    rememberOrcadTunnelTransport(options.connectionId, 'tcp_forward')
    return started
  }

  private async startBridge(
    conn: SshConnection,
    options: PortForwardStartOptions,
    generation: number
  ): Promise<StartedPortForward> {
    this.refusedGenerations.set(conn, generation)
    if (!this.dependencies.stdio.canHandle(conn)) {
      throw new Error(
        'This SSH host refuses TCP forwarding, and the managed Orca server tunnel has no other route.'
      )
    }
    // Why: a closed `ssh -L` (ours, or one an earlier Orca orphaned) may still hold the port.
    if (options.localPort !== 0) {
      await this.dependencies.reserveLocalPort(conn, options)
    }
    const started = await this.dependencies.stdio.start(conn, options)
    rememberOrcadTunnelTransport(options.connectionId, 'stdio_bridge')
    return started
  }
}

/** Only system SSH ever spawned an `ssh -L`, so only there can one be left holding the port. */
export function reserveBridgeLocalPort(
  conn: SshConnection,
  options: PortForwardStartOptions
): Promise<number> {
  if (!conn.usesSystemSshTransport()) {
    return reserveLocalForwardPort(options.localPort)
  }
  const orphanArgs = buildSystemSshPortForwardArgs(
    conn.getTarget(),
    options.localPort,
    options.remoteHost,
    options.remotePort,
    systemSshForwardBuildArgsOptions(conn)
  )
  return reserveLocalForwardPort(options.localPort, orphanArgs)
}
