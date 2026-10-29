// Fall back to the exec bridge when sshd refuses forwarding or standalone forward login fails.
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
  /** Release stale forwards left by earlier clients before binding the persisted port. */
  reserveLocalPort: (conn: SshConnection, options: PortForwardStartOptions) => Promise<unknown>
}

export class OrcadManagedTunnelTransportProvider implements SshPortForwardProvider {
  // Reconnect may change sshd or authentication; scope fallback by transport generation.
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
    // Replies from a replaced transport cannot decide the new generation's route.
    const generation = conn.getConnectGeneration()
    if (this.bridgedGenerations.get(conn) === generation) {
      return this.startBridge(conn, options, generation)
    }
    // Unverifiable probes do not prove forwarding refusal.
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

  private async startForward(
    forward: SshPortForwardProvider,
    conn: SshConnection,
    options: PortForwardStartOptions
  ): Promise<StartedPortForward | { failure: string }> {
    // Capture exits before manager ownership; abandoned forwards must not close replacement bridges.
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
    // System SSH listens locally before requesting a host channel; listener readiness proves no route.
    const verdict = await this.dependencies.checkForward(started)
    // Prefer ssh's exit reason over a generic listener failure before handing off a dead forward.
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
    // Failed standalone authentication remains unavailable until reconnect.
    this.bridgedGenerations.set(conn, generation)
    if (!this.dependencies.stdio.canHandle(conn)) {
      throw new Error(
        `The tunnel to this host’s Orca server has no route: ${forwardFailure}, and there is no stdio bridge.`
      )
    }
    // Closed/orphaned ssh -L processes may still hold the persisted port.
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

/** Cancel only Orca's persisted forward spec, preserving the user's ControlMaster and other forwards. */
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
