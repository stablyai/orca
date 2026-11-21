// Write one PTY binding into the Store's partition as a new session, restorable if the disk write fails.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { freezePublishedWorkspaceSession } from '../../restoring-sessions/published-workspace-session-freeze'
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

export function publishPtyBindingSession(
  runtime: Pick<StoreRuntimeState, 'state'>,
  hostId: ReturnType<typeof resolveHostId>,
  session: WorkspaceSessionState
): void {
  freezePublishedWorkspaceSession(session)
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    runtime.state.workspaceSession = session
  } else {
    runtime.state.workspaceSessionsByHostId = {
      ...runtime.state.workspaceSessionsByHostId,
      [hostId]: session
    }
  }
}

/** Publish the bound session and report the workspaces it changed. */
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
  const { session: bound, workspaces } = applyPtyBinding(args, session, bindingWorktreeId, paneKey)
  try {
    publishPtyBindingSession(runtime, resolvedHostId, bound)
    bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
    markPtyBindingSessionDirty(runtime, resolvedHostId)
  } catch (error) {
    publishPtyBindingSession(runtime, resolvedHostId, session)
    throw error
  }
  return {
    writtenWorkspaces: new Map([[resolvedHostId, workspaces]]),
    rollback: () => {
      const current = sessions.getWorkspaceSession(resolvedHostId)
      const rolledBack = rollbackFailedPtyBinding(
        session,
        bound,
        current,
        bindingWorktreeId,
        args.tabId,
        args.leafId
      )
      if (rolledBack !== current) {
        publishPtyBindingSession(runtime, resolvedHostId, rolledBack)
        bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
      }
    }
  }
}
