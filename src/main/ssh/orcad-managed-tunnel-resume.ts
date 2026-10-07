import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment,
  type RuntimeSshTunnelLink
} from '../../shared/runtime-environments'
import type { SshConnection } from './ssh-connection'
import type { SshTarget } from '../../shared/ssh-types'
import type { OrcadManagedServing } from './orcad-managed-serving'
import type { SshConnectionManager } from './ssh-connection-manager'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { getSshTargetRegistryStore } from './ssh-target-registry'
import {
  dropActiveOrcadTunnel,
  managedTunnelAccess,
  recordActiveOrcadTunnel,
  type ActiveOrcadTunnel
} from './orcad-managed-tunnel-active'
import {
  environmentForwardChecks,
  forwardToVerifiedOrcad,
  type OrcadManagedTunnelTargeting
} from './orcad-managed-tunnel-target'

export type OrcadManagedTunnelProbe = (
  environment: KnownRuntimeEnvironment,
  timeoutMs: number
) => Promise<boolean>

export type OrcadManagedServingCheck = (input: {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: SshConnection
  remotePort: number
}) => Promise<OrcadManagedServing>

export type OrcadManagedTunnelResumeOptions = {
  attempts: number
  resolveEnvironment: (environmentId: string) => KnownRuntimeEnvironment | null
  timeoutMs: number
}

type ResumeRecoveryDependencies = {
  active: Map<string, ActiveOrcadTunnel>
  forwards: SshPortForwardManager
  getConnectionManager: () => SshConnectionManager | null
  getManagerGeneration: () => number
  getTargetStore: () => ReturnType<typeof getSshTargetRegistryStore>
  inFlight: Map<string, Promise<void>>
  ownershipGenerations: Map<string, number>
  probeTunnel?: OrcadManagedTunnelProbe
  targeting: OrcadManagedTunnelTargeting
  /** Never rebuilds: a server restarted on a new port drops this forward for the next ensure. */
  checkServing?: (environment: KnownRuntimeEnvironment) => Promise<unknown>
}

type ResolvedManagedTunnelEnvironment = {
  deployment: RuntimeSshTunnelLink
  environment: KnownRuntimeEnvironment
}

export class OrcadManagedTunnelResumeRecovery {
  private readonly probeTunnel: OrcadManagedTunnelProbe
  private resumeInFlight: Promise<void> | null = null

  constructor(private readonly dependencies: ResumeRecoveryDependencies) {
    this.probeTunnel = dependencies.probeTunnel ?? probeManagedOrcadTunnel
  }

  dispose(): void {
    this.resumeInFlight = null
  }

  recover(options: OrcadManagedTunnelResumeOptions): Promise<void> {
    if (this.resumeInFlight) {
      return this.resumeInFlight
    }
    const managerGeneration = this.dependencies.getManagerGeneration()
    const recoveries = [...this.dependencies.active].map(([environmentId, active]) =>
      this.recoverActive(environmentId, active, managerGeneration, options)
    )
    const operation = Promise.allSettled(recoveries)
      .then((results) => {
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (failed) {
          throw failed.reason
        }
      })
      .finally(() => {
        if (this.resumeInFlight === operation) {
          this.resumeInFlight = null
        }
      })
    this.resumeInFlight = operation
    return operation
  }

  private async recoverActive(
    environmentId: string,
    active: ActiveOrcadTunnel,
    managerGeneration: number,
    options: OrcadManagedTunnelResumeOptions
  ): Promise<void> {
    const ownershipGeneration = this.dependencies.ownershipGenerations.get(environmentId) ?? 0
    for (let attempt = 0; attempt < options.attempts; attempt++) {
      const resolved = this.resolveEnvironment(environmentId, active, options)
      if (!resolved) {
        return
      }
      if (await this.probeTunnel(resolved.environment, options.timeoutMs)) {
        return
      }
      if (!this.stillOwned(environmentId, active, ownershipGeneration, managerGeneration)) {
        return
      }
    }

    const pending = this.dependencies.inFlight.get(environmentId)
    if (pending) {
      await pending.catch(() => undefined)
    }
    if (!this.stillOwned(environmentId, active, ownershipGeneration, managerGeneration)) {
      return
    }
    const resolved = this.resolveEnvironment(environmentId, active, options)
    const connectionManager = this.dependencies.getConnectionManager()
    if (
      !resolved ||
      !connectionManager ||
      connectionManager.getConnection(active.targetId) !== active.connection
    ) {
      return
    }
    const operation = this.reconnectAndRebuild(
      resolved.environment,
      active,
      connectionManager,
      ownershipGeneration,
      managerGeneration,
      options
    ).finally(() => {
      if (this.dependencies.inFlight.get(environmentId) === operation) {
        this.dependencies.inFlight.delete(environmentId)
      }
    })
    this.dependencies.inFlight.set(environmentId, operation)
    await operation
  }

  private async reconnectAndRebuild(
    environment: KnownRuntimeEnvironment,
    active: ActiveOrcadTunnel,
    connectionManager: SshConnectionManager,
    ownershipGeneration: number,
    managerGeneration: number,
    options: OrcadManagedTunnelResumeOptions
  ): Promise<void> {
    await connectionManager.reconnect(active.targetId)
    if (
      !this.stillOwned(environment.id, active, ownershipGeneration, managerGeneration) ||
      connectionManager !== this.dependencies.getConnectionManager() ||
      connectionManager.getConnection(active.targetId) !== active.connection ||
      connectionManager.getState(active.targetId)?.status !== 'connected' ||
      active.connection.getConnectGeneration() <= active.transportGeneration
    ) {
      return
    }
    if (!this.resolveEnvironment(environment.id, active, options)) {
      return
    }

    const currentActive = this.dependencies.active.get(environment.id)
    if (currentActive && currentActive !== active) {
      return
    }
    if (currentActive === active) {
      await dropActiveOrcadTunnel(
        this.dependencies.active,
        this.dependencies.forwards,
        environment.id,
        active
      )
    }
    if (!this.stillOwned(environment.id, active, ownershipGeneration, managerGeneration)) {
      return
    }

    const current = this.resolveEnvironment(environment.id, active, options)
    if (!current) {
      return
    }
    const { deployment } = current
    const target = this.dependencies.getTargetStore()?.getTarget(active.targetId)
    if (!target) {
      return
    }
    const transportGeneration = active.connection.getConnectGeneration()
    const checks = await environmentForwardChecks(this.dependencies.targeting, {
      environment: current.environment,
      target,
      connection: active.connection
    })
    const forward = await forwardToVerifiedOrcad({
      targetId: active.targetId,
      connection: active.connection,
      forwards: this.dependencies.forwards,
      localPort: deployment.localPort,
      label: `Managed Orca server: ${current.environment.name}`,
      ...checks,
      stillCurrent: () =>
        active.connection.getConnectGeneration() === transportGeneration &&
        this.stillOwned(environment.id, active, ownershipGeneration, managerGeneration) &&
        this.resolveEnvironment(environment.id, active, options) !== null
    })
    if (!forward) {
      return
    }
    recordActiveOrcadTunnel(this.dependencies.active, environment.id, forward, {
      connection: active.connection,
      preferredPort: deployment.remotePort,
      sshTargetGeneration: active.sshTargetGeneration,
      targetId: active.targetId,
      transportGeneration
    })
    // A server that idled out while this client slept is started here, not reported as lost.
    await this.dependencies.checkServing?.(current.environment)
  }

  private resolveEnvironment(
    environmentId: string,
    active: ActiveOrcadTunnel,
    options: OrcadManagedTunnelResumeOptions
  ): ResolvedManagedTunnelEnvironment | null {
    const environment = options.resolveEnvironment(environmentId)
    const deployment = managedTunnelAccess(
      environment,
      this.dependencies.getTargetStore()?.getTarget(active.targetId),
      {
        environmentId,
        sshTargetId: active.targetId,
        sshTargetGeneration: active.sshTargetGeneration,
        localPort: active.localPort,
        remotePort: active.preferredPort
      }
    )
    return environment && deployment ? { deployment, environment } : null
  }

  private stillOwned(
    environmentId: string,
    active: ActiveOrcadTunnel,
    ownershipGeneration: number,
    managerGeneration: number
  ): boolean {
    const current = this.dependencies.active.get(environmentId)
    return (
      this.dependencies.getManagerGeneration() === managerGeneration &&
      (this.dependencies.ownershipGenerations.get(environmentId) ?? 0) === ownershipGeneration &&
      (current === active || current === undefined)
    )
  }
}

export async function probeManagedOrcadTunnel(
  environment: KnownRuntimeEnvironment,
  timeoutMs: number
): Promise<boolean> {
  try {
    await sendRemoteRuntimeRequest(
      getPreferredPairingOffer(environment),
      'status.get',
      undefined,
      timeoutMs
    )
    return true
  } catch {
    return false
  }
}
