import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshConnection } from './ssh-connection'
import type { SshConnectionManager } from './ssh-connection-manager'
import { SshPortForwardManager } from './ssh-port-forward'
import {
  OrcadManagedTunnelResumeRecovery,
  type ActiveOrcadTunnel,
  type OrcadManagedTunnelProbe,
  type OrcadManagedTunnelResumeOptions
} from './orcad-managed-tunnel-resume'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'

type OrcadManagedTunnelDependencies = {
  getConnectionManager: () => SshConnectionManager | null
  getTargetStore: () => ReturnType<typeof getSshTargetRegistryStore>
  forwardManager?: SshPortForwardManager
  probeTunnel?: OrcadManagedTunnelProbe
}

export class OrcadManagedTunnelManager {
  private readonly active = new Map<string, ActiveOrcadTunnel>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly ownershipGenerations = new Map<string, number>()
  private readonly forwards: SshPortForwardManager
  private readonly resumeRecovery: OrcadManagedTunnelResumeRecovery
  private managerGeneration = 0

  constructor(private readonly dependencies: OrcadManagedTunnelDependencies) {
    this.forwards = dependencies.forwardManager ?? new SshPortForwardManager()
    this.resumeRecovery = new OrcadManagedTunnelResumeRecovery({
      active: this.active,
      forwards: this.forwards,
      getConnectionManager: dependencies.getConnectionManager,
      getManagerGeneration: () => this.managerGeneration,
      getTargetStore: dependencies.getTargetStore,
      inFlight: this.inFlight,
      ownershipGenerations: this.ownershipGenerations,
      probeTunnel: dependencies.probeTunnel
    })
    this.forwards.setCallbacks({
      onForwardClosed: (entry) => {
        for (const [environmentId, active] of this.active) {
          if (active.forwardId === entry.id) {
            this.active.delete(environmentId)
          }
        }
      }
    })
  }

  ensure(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null = () => environment
  ): Promise<void> {
    if (!getRuntimeSshAccess(environment)) {
      return Promise.resolve()
    }
    const pending = this.inFlight.get(environment.id)
    if (pending) {
      return pending
    }
    const operation = this.ensureManagedTunnel(environment, resolveCurrent).finally(() => {
      if (this.inFlight.get(environment.id) === operation) {
        this.inFlight.delete(environment.id)
      }
    })
    this.inFlight.set(environment.id, operation)
    return operation
  }

  async start(
    environmentId: string,
    target: SshTarget,
    connection: SshConnection,
    remotePort: number
  ): Promise<number> {
    if (!target.generation) {
      throw new Error('Managed Orca SSH target has no registration generation.')
    }
    const managerGeneration = this.managerGeneration
    const ownershipGeneration = (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    const transportGeneration = connection.getTransportGeneration()
    const stillCurrent = (): boolean =>
      this.managerGeneration === managerGeneration &&
      this.ownershipGenerations.get(environmentId) === ownershipGeneration &&
      connection.getTransportGeneration() === transportGeneration
    await this.close(environmentId)
    if (!stillCurrent()) {
      throw new Error('Orca SSH tunnel setup was superseded.')
    }
    const forward = await this.forwards.addForward(
      target.id,
      connection,
      0,
      '127.0.0.1',
      remotePort,
      `Managed Orca server`
    )
    if (!stillCurrent()) {
      await this.forwards.removeForwardAndWait(forward.id)
      throw new Error('Orca SSH tunnel setup was superseded.')
    }
    this.active.set(environmentId, {
      connection,
      forwardId: forward.id,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      sshTargetGeneration: target.generation,
      targetId: target.id,
      transportGeneration
    })
    return forward.localPort
  }

  async close(environmentId: string): Promise<void> {
    this.ownershipGenerations.set(
      environmentId,
      (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    )
    const active = this.active.get(environmentId)
    if (!active) {
      return
    }
    this.active.delete(environmentId)
    await this.forwards.removeForwardAndWait(active.forwardId)
  }

  dispose(): void {
    this.managerGeneration += 1
    this.active.clear()
    this.inFlight.clear()
    this.ownershipGenerations.clear()
    this.resumeRecovery.dispose()
    this.forwards.dispose()
  }

  recoverAfterHostResume(options: OrcadManagedTunnelResumeOptions): Promise<void> {
    return this.resumeRecovery.recover(options)
  }

  private async ensureManagedTunnel(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null
  ): Promise<void> {
    const deployment = getRuntimeSshAccess(environment)
    if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
      throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
    }
    const targetStore = this.dependencies.getTargetStore()
    const connectionManager = this.dependencies.getConnectionManager()
    if (!targetStore || !connectionManager) {
      throw new Error('SSH is unavailable on this client; the managed Orca server is unverifiable.')
    }
    const target = targetStore.getTarget(deployment.sshTargetId)
    if (!target || target.generation !== deployment.sshTargetGeneration) {
      throw new Error(
        'The SSH registration for this managed Orca server was removed or re-created.'
      )
    }
    if (getManagedOrcadOwnerEnvironmentId(target.owner) !== environment.id) {
      throw new Error('The SSH target is no longer owned by this managed Orca server.')
    }

    const managerGeneration = this.managerGeneration
    const ownershipGeneration = this.ownershipGenerations.get(environment.id) ?? 0
    const stillOwned = (): boolean => {
      const currentTarget = targetStore.getTarget(target.id)
      const currentEnvironment = resolveCurrent()
      const currentAccess = currentEnvironment ? getRuntimeSshAccess(currentEnvironment) : undefined
      return (
        this.managerGeneration === managerGeneration &&
        (this.ownershipGenerations.get(environment.id) ?? 0) === ownershipGeneration &&
        currentTarget?.generation === target.generation &&
        getManagedOrcadOwnerEnvironmentId(currentTarget?.owner) === environment.id &&
        currentEnvironment?.id === environment.id &&
        currentEnvironment.runtimeId === environment.runtimeId &&
        (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) ===
          (environment.pairingRevision ?? environment.createdAt) &&
        currentEnvironment.connectionDependency === 'ssh-tunnel' &&
        currentAccess?.sshTargetId === deployment.sshTargetId &&
        currentAccess.sshTargetGeneration === deployment.sshTargetGeneration &&
        currentAccess.localPort === deployment.localPort &&
        currentAccess.remotePort === deployment.remotePort
      )
    }
    const connection = await connectionManager.connect(target)
    if (!stillOwned()) {
      return
    }
    const transportGeneration = connection.getTransportGeneration()
    const active = this.active.get(environment.id)
    if (
      active?.connection === connection &&
      active.transportGeneration === transportGeneration &&
      active.targetId === target.id &&
      active.sshTargetGeneration === target.generation &&
      active.localPort === deployment.localPort &&
      active.remotePort === deployment.remotePort
    ) {
      return
    }
    if (active) {
      await this.forwards.removeForwardAndWait(active.forwardId)
      if (this.active.get(environment.id) === active) {
        this.active.delete(environment.id)
      }
    }
    if (!stillOwned()) {
      return
    }
    const forward = await this.forwards.addForward(
      target.id,
      connection,
      deployment.localPort,
      '127.0.0.1',
      deployment.remotePort,
      `Managed Orca server: ${environment.name}`
    )
    if (forward.localPort !== deployment.localPort) {
      await this.forwards.removeForwardAndWait(forward.id)
      throw new Error('Managed Orca tunnel bound an unexpected local port.')
    }
    if (!stillOwned() || connection.getTransportGeneration() !== transportGeneration) {
      await this.forwards.removeForwardAndWait(forward.id)
      return
    }
    this.active.set(environment.id, {
      connection,
      forwardId: forward.id,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      sshTargetGeneration: target.generation,
      targetId: target.id,
      transportGeneration
    })
  }
}

const managedTunnels = new OrcadManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore
})

export async function ensureOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<void> {
  const environment = resolveEnvironment(userDataPath, selector)
  await managedTunnels.ensure(environment, () => {
    try {
      return resolveEnvironment(userDataPath, environment.id)
    } catch {
      return null
    }
  })
}

export function disposeOrcadManagedTunnels(): void {
  managedTunnels.dispose()
}

export function recoverOrcadManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => {
      try {
        return resolveEnvironment(userDataPath, environmentId)
      } catch {
        return null
      }
    }
  })
}

export function startOrcadManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort)
}

export function closeOrcadManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}
