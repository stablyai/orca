import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectSurfaceSession } from '../../../shared/workspace-surfaces/surface-session-projection'
import type { StoreRuntimeState } from './store-runtime-state'

/** Session snapshots own the device shell; initialized host content always comes from its repository. */
export function canonicalSessionProjection(
  runtime: Pick<StoreRuntimeState, 'workspaceSurfaces' | 'state'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const repository = runtime.workspaceSurfaces
  return repository?.initialized(hostId)
    ? projectSurfaceSession(
        hostId,
        {
          ...session,
          closedTerminalTabTombstonesByTabId: (hostId === 'local'
            ? runtime.state.workspaceSession
            : runtime.state.workspaceSessionsByHostId?.[hostId]
          )?.closedTerminalTabTombstonesByTabId
        },
        repository.all(hostId),
        repository.chatInitialized?.(hostId) ?? true,
        repository.unresolvedNativeSessionIds?.(hostId),
        new Set(),
        repository.projectionCache?.(hostId)
      )
    : session
}
