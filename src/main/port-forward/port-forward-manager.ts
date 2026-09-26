import type { Duplex } from 'node:stream'
import type { PairingOffer } from '../../shared/pairing'
import { PortForwardListener, type PortForwardBinding } from './port-forward-listener'
import { PortForwardTransport } from './port-forward-transport'

export type PortForwardHandle = PortForwardBinding & {
  /** Loopback URL on this machine that reaches the host's port. */
  url: string
}

type EnvironmentForwards = {
  transport: PortForwardTransport
  /** Keyed by remote port. */
  forwards: Map<number, { listener: PortForwardListener; handle: PortForwardHandle }>
  pending: Map<number, Promise<PortForwardHandle>>
}

export type PortForwardManagerDeps = {
  createTransport: (pairing: PairingOffer, onLost: (error: Error) => void) => PortForwardTransport
  createListener: (open: () => Promise<Duplex>) => PortForwardListener
}

const defaultDeps: PortForwardManagerDeps = {
  createTransport: (pairing, onLost) => new PortForwardTransport({ pairing, onLost }),
  createListener: (open) => new PortForwardListener(open)
}

/**
 * Owns the loopback forwards this client holds open, one subscription per environment
 * and one listener per remote port.
 *
 * A forward is shared, not per-consumer: two surfaces asking for the same remote port
 * get the same local port, because handing out two would double the listeners and give
 * the user two different URLs for one dev server.
 */
export class PortForwardManager {
  private readonly deps: PortForwardManagerDeps
  private readonly environments = new Map<string, EnvironmentForwards>()

  constructor(deps: PortForwardManagerDeps = defaultDeps) {
    this.deps = deps
  }

  async ensure(
    environmentId: string,
    pairing: PairingOffer,
    remotePort: number
  ): Promise<PortForwardHandle> {
    const environment = this.environmentFor(environmentId, pairing)
    const existing = environment.forwards.get(remotePort)
    if (existing) {
      return existing.handle
    }
    // Why an in-flight map: two surfaces can request the same port in the same tick, and
    // without this each would bind its own listener and the second would win silently.
    const pending = environment.pending.get(remotePort)
    if (pending) {
      return pending
    }
    const attempt = this.open(environmentId, environment, remotePort).finally(() => {
      environment.pending.delete(remotePort)
    })
    environment.pending.set(remotePort, attempt)
    return attempt
  }

  private environmentFor(environmentId: string, pairing: PairingOffer): EnvironmentForwards {
    const existing = this.environments.get(environmentId)
    if (existing) {
      return existing
    }
    const created: EnvironmentForwards = {
      transport: this.deps.createTransport(pairing, () => this.closeEnvironment(environmentId)),
      forwards: new Map(),
      pending: new Map()
    }
    this.environments.set(environmentId, created)
    return created
  }

  private async open(
    environmentId: string,
    environment: EnvironmentForwards,
    remotePort: number
  ): Promise<PortForwardHandle> {
    const tunnel = await environment.transport.start()
    const listener = this.deps.createListener(() =>
      tunnel.open({ host: '127.0.0.1', port: remotePort })
    )
    try {
      const binding = await listener.listen(remotePort)
      const handle: PortForwardHandle = {
        ...binding,
        url: `http://127.0.0.1:${binding.port}`
      }
      // Why re-check: the environment may have been torn down while listen() awaited,
      // which would otherwise leave an orphaned listener bound with no owner.
      if (this.environments.get(environmentId) !== environment) {
        await listener.close()
        throw new Error('port_forward_environment_closed')
      }
      environment.forwards.set(remotePort, { listener, handle })
      return handle
    } catch (error) {
      await listener.close()
      throw error
    }
  }

  get(environmentId: string, remotePort: number): PortForwardHandle | null {
    return this.environments.get(environmentId)?.forwards.get(remotePort)?.handle ?? null
  }

  async release(environmentId: string, remotePort: number): Promise<void> {
    const environment = this.environments.get(environmentId)
    const forward = environment?.forwards.get(remotePort)
    if (!environment || !forward) {
      return
    }
    environment.forwards.delete(remotePort)
    await forward.listener.close()
    // Why re-check, as open() does: closeEnvironment works by id, and the environment
    // this call observed as empty may have been replaced by a live one while close()
    // awaited — tearing that replacement down would kill forwards nobody released.
    if (
      this.environments.get(environmentId) === environment &&
      environment.forwards.size === 0 &&
      environment.pending.size === 0
    ) {
      this.closeEnvironment(environmentId)
    }
  }

  closeEnvironment(environmentId: string): void {
    const environment = this.environments.get(environmentId)
    if (!environment) {
      return
    }
    this.environments.delete(environmentId)
    for (const { listener } of environment.forwards.values()) {
      void listener.close()
    }
    environment.forwards.clear()
    environment.transport.close()
  }

  closeAll(): void {
    // Deleting the current key while iterating a Map is well-defined, so no snapshot.
    for (const environmentId of this.environments.keys()) {
      this.closeEnvironment(environmentId)
    }
  }
}
