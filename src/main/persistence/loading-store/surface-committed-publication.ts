import { rekeySurfacePaneProfileRecords } from '../../workspace-surfaces/surface-pane-profile-records'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { projectSurfaceSession } from '../../../shared/workspace-surfaces/surface-session-projection'
import { emptySurfaceProfileDomain } from '../../../shared/workspace-surfaces/surface-profile-domain'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
import { SurfaceCatalog } from '../../workspace-surfaces/surface-catalog'
import { assignWorkspaceSessionPartition } from '../terminal-topology/terminal-topology-membership'
import type { StoreRuntimeState } from './store-runtime-state'
import { notifyWorkspaceSessionOperationEnded } from './workspace-session-write-listeners'
import { reboundLeafIds } from '../terminal-topology/layout-command-binding-generations'
import { bumpPtyBindingGeneration } from './pty-binding-generations'

/** A committed command always publishes, including when its caller no longer has a view. */
export function publishCommittedSurfaceCommand(
  runtime: StoreRuntimeState,
  hostId: ExecutionHostId,
  command: SurfaceStorageCommand,
  before: WorkspaceSessionState,
  generation: number,
  result: SurfaceStorageResult,
  notify: (publish: () => void) => void = (publish) => publish()
): void {
  if (result.changedWorkspaces?.length === 0) {
    notify(() => {
      for (const listener of runtime.workspaceSurfaceCommitListeners) {
        try {
          listener(result)
        } catch {
          /* Recovery cannot uncommit a command. */
        }
      }
    })
    return
  }
  const catalog =
    runtime.workspaceSurfaces instanceof SurfaceCatalog
      ? runtime.workspaceSurfaces
      : new SurfaceCatalog(emptySurfaceProfileDomain())
  if (result.changes) {
    catalog.adoptCommittedChanges(result.hostId, result.host, result.changes)
  } else {
    catalog.adoptCommittedHost(result.hostId, result.host)
  }
  runtime.workspaceSurfaces = catalog
  const current = readSurfaceRuntimeSession(runtime, hostId)
  const presentation = patchStoredSession(
    current,
    command.type === 'layout' ? command.session : before,
    result.session
  )
  const session = projectSurfaceSession(
    hostId,
    presentation,
    result.host.surfaces,
    result.host.chatInitialization === 'verified',
    catalog.unresolvedNativeSessionIds(hostId),
    new Set(),
    catalog.projectionCache(hostId)
  )
  Object.assign(
    runtime.state,
    rekeySurfacePaneProfileRecords(runtime.state, command, result.outcome)
  )
  assignWorkspaceSessionPartition(runtime.state, hostId, session)
  for (const leafId of reboundLeafIds(current, session)) {
    bumpPtyBindingGeneration(runtime, hostId, leafId)
  }
  runtime.lastWrittenStateHash = null
  if (command.type !== 'query') {
    runtime.writeGeneration += 1
    if (generation === runtime.writeGeneration - 1) {
      runtime.lastDurableWriteGeneration = runtime.writeGeneration
    }
  }
  notify(() => {
    if (command.type !== 'query') {
      for (const listener of runtime.workspaceSurfaceCommitListeners) {
        try {
          listener(result)
        } catch {
          /* Recovery cannot uncommit a command. */
        }
      }
    }
    notifyWorkspaceSessionOperationEnded(runtime, [hostId])
  })
}

export function readSurfaceRuntimeSession(
  runtime: StoreRuntimeState,
  hostId: ExecutionHostId
): WorkspaceSessionState {
  return hostId === 'local'
    ? runtime.state.workspaceSession
    : (runtime.state.workspaceSessionsByHostId?.[hostId] ?? getDefaultWorkspaceSession())
}
