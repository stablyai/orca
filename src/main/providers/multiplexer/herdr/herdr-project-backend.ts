import type { Project } from '../../../../shared/project-types'
import { resolveDesiredTerminalBackend } from '../../../../shared/terminal-backend'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'

export function projectWantsHerdr(
  project: Pick<Project, 'terminalBackendPreference' | 'terminalBackendByHost'>,
  globalDefault: ReturnType<typeof resolveDesiredTerminalBackend>,
  hostId: ExecutionHostId
): boolean {
  return (
    resolveDesiredTerminalBackend({
      globalDefault,
      preference: project.terminalBackendPreference ?? 'inherit',
      activation: project.terminalBackendByHost?.[hostId]
    }) === 'herdr'
  )
}

export function resolveSpawnHostId(
  requestedHostId: ExecutionHostId,
  worktreeHostId: string | undefined
): ExecutionHostId {
  if (requestedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return requestedHostId
  }
  if (worktreeHostId?.startsWith('wsl:')) {
    return worktreeHostId as ExecutionHostId
  }
  return LOCAL_EXECUTION_HOST_ID
}

export function commitHerdrHostActivation(
  store: Store,
  projectId: string,
  hostId: ExecutionHostId
): void {
  const latest = store.getProjects().find((entry) => entry.id === projectId)
  if (!latest || typeof store.updateProject !== 'function') {
    return
  }
  const current = latest.terminalBackendByHost?.[hostId]
  if (current?.state === 'ready' && current.backend === 'herdr') {
    return
  }
  store.updateProject(projectId, {
    terminalBackendByHost: {
      ...latest.terminalBackendByHost,
      [hostId]: { backend: 'herdr', state: 'ready' }
    }
  })
}
