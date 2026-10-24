import {
  cancelManagedOrcadStop,
  forgetManagedOrcadEnvironment,
  stopManagedOrcadEnvironment
} from '../../managed-server/lifecycle/orcad-runtime-decommission'
import { getManagedOrcadRuntimeStatus } from '../../managed-server/lifecycle/orcad-runtime-status'
import {
  recoverManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  updateManagedOrcadEnvironment
} from '../../ssh/orcad-runtime-maintenance'
import { getOrcadSshDeployment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type {
  OrcadManagedRestartResult,
  OrcadManagedStaleLockReclaimRequest,
  OrcadManagedStaleLockReclaimResult
} from '../../../shared/orcad-managed-runtime'
import { restartManagedOrcadEnvironment } from '../../managed-server/lifecycle/orcad-managed-launch-session'
import { runManagedOrcadStaleLockReclaim } from '../../managed-server/lifecycle/orcad-managed-stale-lock-reclaim'
import { clearLaunchSessionNote } from './runtime-environment-managed-tunnel'
import { forgetLaunchSessionVerdict } from '../ssh/ssh-host-launch-session-note'
import type { ManagedServerActions } from '../../runtime/managed-server-actions-registry'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from './runtime-environment-removal-cleanup'

export type ManagedOrcadActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
  clearHostServerNotes: (sshTargetId: string, environmentId: string) => void
  clearHostServerStatus: (sshTargetId: string) => void
  store: RemovedServerStore
}

export function createManagedOrcadActions(
  options: ManagedOrcadActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  const unlinkPolicy = {
    isActiveEnvironment: (environmentId: string) =>
      options.getActiveEnvironmentId() === environmentId,
    retireLocalState: (environmentId: string) =>
      retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport, options.store)
  }
  return {
    status: (selector) => getManagedOrcadRuntimeStatus(userDataPath(), selector),
    update: async (selector, force) => {
      const result = await updateManagedOrcadEnvironment(userDataPath(), { selector, force })
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      if (result.outcome !== 'deferred') {
        const targetId = getOrcadSshDeployment(result.environment)?.sshTargetId
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

export async function restartManagedOrcad(
  options: ManagedOrcadActionOptions,
  selector: string
): Promise<OrcadManagedRestartResult> {
  const result = await restartManagedOrcadEnvironment(options.getUserDataPath(), selector)
  if (result.outcome === 'restarted') {
    await reconnectRestartedManagedOrcad(options, result.environmentId)
  }
  return result
}

export async function reclaimManagedOrcadStaleLock(
  options: ManagedOrcadActionOptions,
  selector: string,
  request: OrcadManagedStaleLockReclaimRequest
): Promise<OrcadManagedStaleLockReclaimResult> {
  const result = await runManagedOrcadStaleLockReclaim(options.getUserDataPath(), selector, request)
  // Reconnect also replaces stale-lock feedback when no process had started.
  if (result.status === 'reclaimed') {
    await reconnectRestartedManagedOrcad(options, result.environmentId)
  }
  return result
}

async function reconnectRestartedManagedOrcad(
  options: ManagedOrcadActionOptions,
  environmentId: string
): Promise<void> {
  await options.invalidateTransport(environmentId)
  const environment = resolveEnvironment(options.getUserDataPath(), environmentId)
  const targetId = getOrcadSshDeployment(environment)?.sshTargetId
  if (targetId) {
    options.clearHostServerNotes(targetId, environmentId)
    forgetLaunchSessionVerdict(targetId)
    clearLaunchSessionNote(targetId, environmentId)
  }
}
