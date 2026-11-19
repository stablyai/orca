// Write one PTY binding into the Store's partition in place, restorable if the disk write fails.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../../restoring-sessions/session-owner-fields'
import type { DurableProfileStateMutation, StoreRuntimeState } from '../store-runtime-state'
import type {
  resolveHostId,
  SessionHostPartitionOperations
} from '../workspace-sessions/session-host-partitions'
import { bumpPtyBindingGeneration } from './pty-binding-generations'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'
import { applyPtyBinding } from './pty-binding-session-update'
import { rollbackFailedPtyBinding } from './pty-binding-write-rollback'

export function markPtyBindingSessionDirty(
  runtime: Pick<StoreRuntimeState, 'dirtyProfileStateDomains'>,
  hostId: ReturnType<typeof resolveHostId>
): void {
  runtime.dirtyProfileStateDomains?.add(
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  )
}

/** Bind in place and report the workspaces it changed. */
export function writePtyBinding(
  {
    runtime,
    sessions
  }: {
    runtime: Pick<StoreRuntimeState, 'state' | 'dirtyProfileStateDomains' | 'ptyBindingGenerations'>
    sessions: Pick<SessionHostPartitionOperations, 'getWorkspaceSession'>
  },
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  resolvedHostId: ReturnType<typeof resolveHostId>,
  bindingWorktreeId: string,
  paneKey: string
): Pick<DurableProfileStateMutation<boolean>, 'rollback' | 'writtenWorkspaces'> {
  const sessionBeforeBinding = cloneWorkspaceSessionState(session)
  const restore = (restoredSession = sessionBeforeBinding): void => {
    if (resolvedHostId === LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSession = restoredSession
    } else {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: restoredSession
      }
    }
  }
  try {
    if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolvedHostId]: session
      }
    }
    const workspaces = applyPtyBinding(args, session, bindingWorktreeId, paneKey)
    bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
    markPtyBindingSessionDirty(runtime, resolvedHostId)
    const boundSession = cloneWorkspaceSessionState(session)
    return {
      writtenWorkspaces: new Map([[resolvedHostId, workspaces]]),
      rollback: () => {
        const current = sessions.getWorkspaceSession(resolvedHostId)
        const rolledBack = rollbackFailedPtyBinding(
          sessionBeforeBinding,
          boundSession,
          current,
          bindingWorktreeId,
          args.tabId,
          args.leafId
        )
        if (rolledBack !== current) {
          restore(rolledBack)
          bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
        }
      }
    }
  } catch (error) {
    restore()
    throw error
  }
}
