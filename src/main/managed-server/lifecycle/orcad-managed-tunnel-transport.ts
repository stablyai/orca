/**
 * The managed tunnel's transport choice, made each time a tunnel starts: the SSH local forward
 * wherever it starts, and the stdio bridge wherever it does not — sshd refuses forwarding, or the
 * forward's own login fails where the connection's exec still works (a ControlMaster holding an
 * MFA or hardware-key login it cannot repeat).
 */
import { OrcadStdioBridgePortForwardProvider } from './orcad-stdio-bridge-provider'
import { rememberOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import {
  checkForwardChannel,
  probeTcpForwarding,
  type ForwardChannelVerdict,
  type TcpForwardingVerdict
} from '../../ssh/ssh-tcp-forwarding-probe'
import { Ssh2PortForwardProvider } from '../../ssh/port-forwarding/ssh2-port-forward-provider'
import {
  SystemSshPortForwardProvider,
  systemSshForwardBuildArgsOptions
} from '../../ssh/port-forwarding/system-ssh-port-forward-provider'
import { buildSystemSshPortForwardArgs } from '../../ssh/system-transport/system-ssh-forward-process'
import { reserveLocalForwardPort } from '../../ssh/system-transport/system-ssh-forward-port-reservation'
import { cancelMuxedLocalForward } from '../../ssh/system-transport/system-ssh-muxed-forward-cancel'

type OrcadManagedTunnelTransportDependencies = {
  forwards: SshPortForwardProvider[]
  stdio: SshPortForwardProvider
  probe: (conn: SshConnection, port: number) => Promise<TcpForwardingVerdict>
  checkForward: (forward: StartedPortForward) => Promise<ForwardChannelVerdict>
  /** Frees the persisted local port from a forward an earlier Orca left on it, before either binds. */
  reserveLocalPort: (conn: SshConnection, options: PortForwardStartOptions) => Promise<unknown>
}

export class OrcadManagedTunnelTransportProvider implements SshPortForwardProvider {
  // Why per transport generation: a reconnect may route through a different sshd, or log in anew.
  private readonly bridgedGenerations = new WeakMap<SshConnection, number>()

  constructor(
    private readonly dependencies: OrcadManagedTunnelTransportDependencies = {
      forwards: [new Ssh2PortForwardProvider(), new SystemSshPortForwardProvider()],
      stdio: new OrcadStdioBridgePortForwardProvider(),
      probe: probeTcpForwarding,
      checkForward: checkForwardChannel,
      reserveLocalPort: reserveManagedTunnelLocalPort
    }
  ) {}

  canHandle(conn: SshConnection): boolean {
    return this.dependencies.forwards.some((provider) => provider.canHandle(conn))
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const { forwards, probe } = this.dependencies
    // Why captured: a refusal answered by a transport that reconnected meanwhile is not the new one's.
    const generation = conn.getConnectGeneration()
    if (this.bridgedGenerations.get(conn) === generation) {
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
    await this.reserveFixedLocalPort(conn, options)
    const outcome = await this.startForward(forward, conn, options)
    if (!('failure' in outcome)) {
      rememberOrcadTunnelTransport(options.connectionId, 'tcp_forward')
      return outcome
    }
    console.warn(`[ssh] Managed Orca server tunnel takes the stdio bridge: ${outcome.failure}`)
    return this.startBridge(conn, options, generation, outcome.failure)
  }

  /** The one place a forward is judged started; every way it is not leads to the same bridge. */
  private async startForward(
    forward: SshPortForwardProvider,
    conn: SshConnection,
    options: PortForwardStartOptions
  ): Promise<StartedPortForward | { failure: string }> {
    // Why: the manager only hears an exit once it holds the forward, which it does not mid-check,
    // and an abandoned forward's late exit must not read as the bridge's.
    const exits: string[] = []
    let abandoned = false
    let started: StartedPortForward
    try {
      started = await forward.start(conn, {
        ...options,
        onUnexpectedClose: (entry, reason) => {
          if (abandoned) {
            return
          }
          exits.push(reason.kind === 'unexpected-exit' ? (reason.detail ?? 'exited') : 'closed')
          options.onUnexpectedClose?.(entry, reason)
        }
      })
    } catch (error) {
      abandoned = true
      return { failure: error instanceof Error ? error.message : String(error) }
    }
    // Why: system SSH's listener is up before sshd is asked for a channel, so it proves nothing.
    const verdict = await this.dependencies.checkForward(started)
    // Why an exit counts, and first: a forward that dies before it is handed over cannot be the
    // route, and its exit carries ssh's own reason (a refused login) where not-listening has none.
    const failure =
      verdict === 'refused'
        ? 'sshd refused the forward channel'
        : (exits[0] ??
          (verdict === 'not-listening'
            ? 'the forward never listened (its own login did not finish)'
            : null))
    if (failure === null) {
      return started
    }
    abandoned = true
    await started.close()
    return { failure }
  }

  private async startBridge(
    conn: SshConnection,
    options: PortForwardStartOptions,
    generation: number,
    forwardFailure = 'this SSH host refuses TCP forwarding'
  ): Promise<StartedPortForward> {
    // Why for the whole generation: a login the forward could not repeat stays unrepeatable.
    this.bridgedGenerations.set(conn, generation)
    if (!this.dependencies.stdio.canHandle(conn)) {
      throw new Error(
        `The tunnel to this host’s Orca server has no route: ${forwardFailure}, and there is no stdio bridge.`
      )
    }
    // Why: a closed `ssh -L` (ours, or one an earlier Orca orphaned) may still hold the port.
    await this.reserveFixedLocalPort(conn, options)
    const started = await this.dependencies.stdio.start(conn, options)
    rememberOrcadTunnelTransport(options.connectionId, 'stdio_bridge')
    return started
  }

  private async reserveFixedLocalPort(
    conn: SshConnection,
    options: PortForwardStartOptions
  ): Promise<void> {
    if (options.localPort !== 0) {
      await this.dependencies.reserveLocalPort(conn, options)
    }
  }
}

/**
 * Only system SSH ever forwarded this port: an orphaned `ssh -L`, or the ControlMaster an older
 * Orca's forward went through. That master cancels only this spec, the port Orca persisted to orcad.
 */
export function reserveManagedTunnelLocalPort(
  conn: SshConnection,
  options: PortForwardStartOptions
): Promise<number> {
  if (!conn.usesSystemSshTransport()) {
    return reserveLocalForwardPort(options.localPort)
  }
  const buildArgsOptions = systemSshForwardBuildArgsOptions(conn)
  const orphanArgs = buildSystemSshPortForwardArgs(
    conn.getTarget(),
    options.localPort,
    options.remoteHost,
    options.remotePort,
    buildArgsOptions
  )
  return reserveLocalForwardPort(options.localPort, orphanArgs, () =>
    cancelMuxedLocalForward(
      conn.getTarget(),
      options.localPort,
      options.remoteHost,
      options.remotePort,
      buildArgsOptions
    )
  )
}
