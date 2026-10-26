/** One in-memory connection per distro: C4 launch, C5 stdio bridge and loopback-rewritten pairing. Rebind when orcad moves ports; C7 persists onChange results. */
import type {
  WslOrcadConnection,
  WslOrcadConnectionDependencies
} from './wsl-orcad-connection-types'
import {
  WslOrcadConnectionSupersededError,
  WslOrcadLaunchDeferredError
} from './wsl-orcad-connection-errors'
import type { WslHostConnectIntent } from '../../shared/wsl-host-types'
import { errorMessage } from '../../shared/error-message'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import {
  wslConnectFailedStatus,
  type WslOrcadConnectionStatus
} from './wsl-orcad-connection-status'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  defaultWslOrcadEnvironmentId,
  deployAndLaunchWslOrcad,
  type WslOrcadLaunch
} from './wsl-orcad-deploy'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { resolveWslOrcadPairing } from './wsl-orcad-pairing-identity'
import { trackWslOrcadHostEnvironment } from './wsl-orcad-host-environments'
import { listenWslOrcadStdioBridgeOnPreferredPort } from './wsl-orcad-stdio-bridge'

export type {
  WslOrcadConnection,
  WslOrcadConnectionDependencies
} from './wsl-orcad-connection-types'

export type WslOrcadConnectOptions = {
  environmentId?: string
  label?: string
  /** Rebinds a port a persisted pairing offer already names; 0 or absent picks a free one. */
  localPort?: number
  intent?: WslHostConnectIntent
  signal?: AbortSignal
  /** What `onChange` reports while this connect runs and once it is ready (liveness recovery). */
  status?: WslOrcadConnectStatus
}

type WslOrcadConnectStatus = { pending: WslOrcadConnectionStatus; ready: WslOrcadConnectionStatus }

const CONNECTING: WslOrcadConnectionStatus = { state: 'connecting' }
const READY: WslOrcadConnectionStatus = { state: 'ready', census: null }

type ActiveWslOrcadConnection = {
  connection: WslOrcadConnection
  forward: StartedPortForward
}

export class WslOrcadConnectionManager {
  private readonly active = new Map<string, ActiveWslOrcadConnection>()
  private readonly inFlight = new Map<string, Promise<WslOrcadConnection>>()
  private readonly generations = new Map<string, number>()

  constructor(private readonly dependencies: WslOrcadConnectionDependencies = {}) {}

  /** Joins a connect already running for this distro rather than racing a second bridge. */
  ensure(distro: string, options: WslOrcadConnectOptions = {}): Promise<WslOrcadConnection> {
    const name = distro.trim()
    if (!name) {
      return Promise.reject(new Error('A WSL distro name is required'))
    }
    const key = wslDistroHolderKey(name)
    const pending = this.inFlight.get(key)
    if (pending) {
      if (!options.intent) {
        return pending
      }
      // Update/Force needs a separate deploy; joining plain connect would discard intent.
      const generation = this.generation(key)
      return pending
        .catch(() => {})
        .then(() => {
          if (this.generation(key) !== generation) {
            throw new WslOrcadConnectionSupersededError(name)
          }
          return this.ensure(distro, options)
        })
    }
    const status = options.status ?? { pending: CONNECTING, ready: READY }
    // Unchanged live refresh stays quiet; liveness recovery must publish.
    if (options.status || !this.active.has(key)) {
      this.dependencies.onChange?.(name, this.get(name), status.pending)
    }
    const operation = this.connect(name, key, options, status).catch((error: unknown) => {
      // Liveness owns reconnect status; superseded connects are already closed.
      if (!options.status && !(error instanceof WslOrcadConnectionSupersededError)) {
        const deferral = error instanceof WslOrcadLaunchDeferredError ? error.launch : null
        const failed = wslConnectFailedStatus(errorMessage(error), deferral)
        this.dependencies.onChange?.(name, this.get(name), failed)
      }
      throw error
    })
    const tracked: Promise<WslOrcadConnection> = operation.finally(() => {
      if (this.inFlight.get(key) === tracked) {
        this.inFlight.delete(key)
      }
    })
    this.inFlight.set(key, tracked)
    return tracked
  }

  /** Prefer persisted enrollment; only unrecorded hosts fall back to their live connection offer. */
  private enrolledOffer(key: string, environmentId: string): PairingOffer | null {
    const current = this.active.get(key)?.connection
    return (
      this.dependencies.getPairingOffer?.(environmentId) ??
      (current?.environmentId === environmentId ? parsePairingCode(current.pairingOffer) : null)
    )
  }

  get(distro: string): WslOrcadConnection | null {
    return this.active.get(wslDistroHolderKey(distro))?.connection ?? null
  }

  /** Liveness reports a status change for a distro, with whatever connection it has now. */
  publish(distro: string, status: WslOrcadConnectionStatus): void {
    this.dependencies.onChange?.(distro, this.get(distro), status)
  }

  list(): WslOrcadConnection[] {
    return [...this.active.values()].map((entry) => entry.connection)
  }

  async close(distro: string): Promise<void> {
    const key = wslDistroHolderKey(distro)
    this.generations.set(key, this.generation(key) + 1)
    const entry = this.active.get(key)
    if (!entry) {
      return
    }
    await this.drop(key, entry)
    this.dependencies.onChange?.(entry.connection.distro, null, { state: 'closed' })
  }

  /** Retires one bridge; unlike close, a connect queued behind it still runs. */
  private async drop(key: string, entry: ActiveWslOrcadConnection): Promise<void> {
    if (this.active.get(key) === entry) {
      this.active.delete(key)
    }
    await entry.forward.close()
    trackWslOrcadHostEnvironment(entry.connection, null)
  }

  async dispose(): Promise<void> {
    const keys = new Set([...this.active.keys(), ...this.inFlight.keys()])
    await Promise.all([...keys].map((key) => this.close(key)))
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0
  }

  private async connect(
    distro: string,
    key: string,
    options: WslOrcadConnectOptions,
    status: WslOrcadConnectStatus
  ): Promise<WslOrcadConnection> {
    const generation = this.generation(key)
    const environmentId = options.environmentId ?? defaultWslOrcadEnvironmentId(distro)
    const label = options.label ?? distro
    const transport = (this.dependencies.createTransport ?? defaultTransport)({
      kind: 'wsl',
      id: environmentId,
      distro,
      label
    })
    // Relaunch stopped orcad on each connect so distro restarts recover.
    const launch = await (this.dependencies.deployAndLaunch ?? deployAndLaunchWslOrcad)(distro, {
      environmentId,
      label,
      intent: options.intent,
      pairedOffer: this.enrolledOffer(key, environmentId),
      signal: options.signal,
      holder: this.dependencies.holder,
      createTransport: () => transport
    })
    if (launch.outcome === 'deferred') {
      throw new WslOrcadLaunchDeferredError(launch)
    }
    if (this.generation(key) !== generation) {
      throw new WslOrcadConnectionSupersededError(distro)
    }
    const current = this.active.get(key)
    const persisted = this.dependencies.getPairingOffer?.(environmentId) ?? null
    const paired = persisted ?? this.enrolledOffer(key, environmentId)
    // Repair only persisted enrollment; an in-progress Add has no stored record to repair.
    const recovery =
      persisted && this.dependencies.pairingRecovery
        ? { ...this.dependencies.pairingRecovery, environmentId }
        : undefined
    if (
      current &&
      current.connection.remotePort === launch.port &&
      current.connection.environmentId === environmentId
    ) {
      const pairingOffer = await resolveWslOrcadPairing(
        launch,
        current.connection.localPort,
        paired,
        this.dependencies.verifyIdentity,
        recovery
      ).catch(async (error: unknown) => {
        // Retire the rejected bridge or publishing its stale token would overwrite pairing repaired by the gate.
        await this.drop(key, current)
        throw error
      })
      if (this.generation(key) !== generation) {
        throw new WslOrcadConnectionSupersededError(distro)
      }
      return this.refreshOffer(
        key,
        current,
        launch,
        pairingOffer,
        options.status ? status.ready : null
      )
    }
    // Port changes invalidate the old bridge; reuse its local port, else the recorded one, when possible.
    const preferredLocalPort =
      current?.connection.localPort ??
      options.localPort ??
      this.dependencies.recordedLocalPort?.(environmentId) ??
      0
    if (current) {
      await this.drop(key, current)
      this.dependencies.onChange?.(distro, null, status.pending)
    }
    const forward = await listenWslOrcadStdioBridgeOnPreferredPort(
      transport,
      {
        environmentId,
        remotePort: launch.port,
        localPort: preferredLocalPort,
        label: `Orca server in WSL: ${label}`
      },
      this.dependencies.listen
    )
    try {
      if (this.generation(key) !== generation) {
        throw new WslOrcadConnectionSupersededError(distro)
      }
      const pairingOffer = await resolveWslOrcadPairing(
        launch,
        forward.entry.localPort,
        paired,
        this.dependencies.verifyIdentity,
        recovery
      )
      if (this.generation(key) !== generation) {
        throw new WslOrcadConnectionSupersededError(distro)
      }
      const entry: ActiveWslOrcadConnection = {
        forward,
        connection: {
          distro,
          environmentId,
          localPort: forward.entry.localPort,
          remotePort: launch.port,
          fullVersion: launch.fullVersion,
          pid: launch.pid,
          pairingOffer,
          deferredUpdate: launch.deferredUpdate ?? null,
          close: () => this.closeEntry(key, entry)
        }
      }
      this.active.set(key, entry)
      trackWslOrcadHostEnvironment(entry.connection, entry.connection)
      this.dependencies.onChange?.(distro, entry.connection, status.ready)
      return entry.connection
    } catch (error) {
      await forward.close()
      throw error
    }
  }

  private refreshOffer(
    key: string,
    entry: ActiveWslOrcadConnection,
    launch: Extract<WslOrcadLaunch, { outcome: 'ready' }>,
    pairingOffer: string,
    /** Reported even when nothing changed; null stays quiet then. */
    announce: WslOrcadConnectionStatus | null
  ): WslOrcadConnection {
    const deferredUpdate = launch.deferredUpdate ?? null
    const changed =
      pairingOffer !== entry.connection.pairingOffer ||
      launch.fullVersion !== entry.connection.fullVersion ||
      launch.pid !== entry.connection.pid ||
      JSON.stringify(deferredUpdate) !== JSON.stringify(entry.connection.deferredUpdate)
    if (changed) {
      const { fullVersion, pid } = launch
      entry.connection = { ...entry.connection, pairingOffer, fullVersion, pid, deferredUpdate }
      this.active.set(key, entry)
    }
    trackWslOrcadHostEnvironment(entry.connection, entry.connection)
    if (changed || announce) {
      this.dependencies.onChange?.(entry.connection.distro, entry.connection, announce ?? READY)
    }
    return entry.connection
  }

  private async closeEntry(key: string, entry: ActiveWslOrcadConnection): Promise<void> {
    if (this.active.get(key) === entry) {
      await this.close(key)
    }
  }
}

function defaultTransport(target: WslOrcadHostTarget): OrcadHostTransport {
  return createWslOrcadHostTransport({ target })
}
