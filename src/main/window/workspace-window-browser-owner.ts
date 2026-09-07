import { app } from 'electron'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentTransportGeneration } from '../ipc/runtime-environment-transport-generation'
import { runtimeEnvironmentRevisionFailure } from '../ipc/runtime-environment-revision-guard'

export type WorkspaceWindowBrowserOwner = {
  runtimeId: string | null
  environmentId?: string
  expectedEnvironmentPairingRevision?: number
}

export function captureWorkspaceWindowBrowserOwner(
  request: WorkspaceWindowBrowserOwner,
  localRuntimeId: string
): (() => boolean) | null {
  if (!request.environmentId && request.runtimeId === localRuntimeId) {
    return () => true
  }
  const userDataPath = app.getPath('userData')
  const candidates = request.environmentId
    ? [resolveEnvironment(userDataPath, request.environmentId)]
    : listEnvironments(userDataPath).filter((entry) => entry.runtimeId === request.runtimeId)
  const environment = candidates.length === 1 ? candidates[0] : undefined
  if (!environment || environment.runtimeId !== request.runtimeId) {
    return null
  }
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new Error('runtime_manually_disconnected')
  }
  if (
    runtimeEnvironmentRevisionFailure(
      environment,
      request.expectedEnvironmentPairingRevision,
      'browser'
    )
  ) {
    throw new Error('runtime_environment_changed')
  }
  const revision = environment.pairingRevision ?? environment.createdAt
  const generation = getRuntimeEnvironmentTransportGeneration(environment.id)
  return () => {
    try {
      const current = resolveEnvironment(userDataPath, environment.id)
      return (
        current.runtimeId === request.runtimeId &&
        !runtimeEnvironmentRevisionFailure(current, revision, 'browser') &&
        !isRuntimeEnvironmentManuallyDisconnected(environment.id) &&
        getRuntimeEnvironmentTransportGeneration(environment.id) === generation
      )
    } catch {
      return false
    }
  }
}
