/** The managed-server actions behind both the Managed servers settings and runtime RPC. */
import {
  cancelManagedOrcadStop,
  forgetManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus,
  recoverManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment,
  updateManagedOrcadEnvironment
} from '../ssh/orcad-runtime-lifecycle'
import type { ManagedServerActions } from '../runtime/managed-server-actions-registry'
import type { ExecutionHostId } from '../../shared/execution-host'
import { retireRemovedRuntimeEnvironment } from './runtime-environment-removal-cleanup'

export type ManagedOrcadActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
  /** Drops the SSH host's stale update/serving notes once an update verified its server. */
  clearHostServerNotes: (sshTargetId: string, environmentId: string) => void
  /** Drops the SSH host's stale managed-server state once its server is unlinked. */
  clearHostServerStatus: (sshTargetId: string) => void
  /** Drops the unlinked server's workspace session partition. */
  forgetHostSession: (hostId: ExecutionHostId) => void
}

export function createManagedOrcadActions(
  options: ManagedOrcadActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  const unlinkPolicy = {
    isActiveEnvironment: (environmentId: string) =>
      options.getActiveEnvironmentId() === environmentId,
    retireLocalState: (environmentId: string) =>
      retireRemovedRuntimeEnvironment(
        environmentId,
        options.invalidateTransport,
        options.forgetHostSession
      )
  }
  return {
    status: (selector) => getManagedOrcadRuntimeStatus(userDataPath(), selector),
    update: async (selector, force) => {
      const result = await updateManagedOrcadEnvironment(userDataPath(), { selector, force })
      // Why: a restarted orcad drops the old connection; reconnect on the new one.
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      if (result.outcome !== 'deferred') {
        const targetId = result.environment.orcadDeployment?.sshTargetId
        if (targetId) {
          options.clearHostServerNotes(targetId, result.environment.id)
        }
      }
      return result
    },
    rollback: async (selector) => {
      const result = await rollbackManagedOrcadEnvironment(userDataPath(), { selector })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    recover: async (selector, acceptChangedState) => {
      const result = await recoverManagedOrcadEnvironment(userDataPath(), {
        selector,
        acceptChangedState: acceptChangedState === true
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    stop: async (selector) => {
      const result = await stopManagedOrcadEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'unlinked') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    },
    cancelStop: (selector) => cancelManagedOrcadStop(userDataPath(), { selector }),
    forget: async (selector) => {
      const result = await forgetManagedOrcadEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'forgotten') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    }
  }
}
