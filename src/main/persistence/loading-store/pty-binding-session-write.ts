import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'
import { cloneWorkspaceSessionState } from '../restoring-sessions/session-owner-fields'
import { rollbackFailedPtyBinding } from './pty-binding-write-rollback'
import { applyPtyBinding } from './pty-binding-session-update'
import { bumpPtyBindingGeneration } from './pty-binding-generations'

export type PtyBindingSessionWriteContext = {
  runtime: Pick<StoreRuntimeState, 'state' | 'ptyBindingGenerations' | 'dirtyProfileStateDomains'>
  sessions: SessionHostPartitionOperations
}

export function writePtyBinding(
  context: PtyBindingSessionWriteContext,
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  resolvedHostId: ExecutionHostId,
  bindingWorktreeId: string,
  paneKey: string
): () => void {
  const { runtime, sessions } = context
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
    applyPtyBinding(args, session, bindingWorktreeId, paneKey)
    bumpPtyBindingGeneration(runtime, resolvedHostId, args.leafId)
    runtime.dirtyProfileStateDomains?.add(
      resolvedHostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
    const boundSession = cloneWorkspaceSessionState(session)
    return () => {
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
  } catch (error) {
    restore()
    throw error
  }
}
