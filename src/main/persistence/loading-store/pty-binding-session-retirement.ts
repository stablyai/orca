import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../restoring-sessions/workspace-session-write-rollback'
import { retireCanonicalPtyBinding } from '../terminal-topology/canonical-binding-retirement'
import { clearReplacedPaneBinding } from './replaced-pane-binding'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { bumpPtyBindingGeneration } from './pty-binding-generations'
import type { StoreRuntimeState } from './store-runtime-state'
import { resolveHostId, type SessionHostPartitionOperations } from './session-host-partitions'
import type { WorkspaceSurfaceCommands } from './workspace-surface-commands'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'

export function retirePtyBindingSession(
  context: {
    runtime: Pick<
      StoreRuntimeState,
      | 'workspaceSurfaces'
      | 'state'
      | 'runDurableMutation'
      | 'dirtyProfileStateDomains'
      | 'ptyBindingGenerations'
    >
    sessions: SessionHostPartitionOperations
    surfaces?: WorkspaceSurfaceCommands
  },
  binding: Pick<PersistPtyBindingArgs, 'worktreeId' | 'tabId' | 'leafId' | 'ptyId'>,
  hostId?: string | null,
  fence?: { incarnationId: string | undefined }
): Promise<boolean> {
  const { runtime, sessions, surfaces } = context
  const resolved = resolveHostId(hostId)
  if (surfaces && runtime.workspaceSurfaces?.initialized(resolved)) {
    return retireCanonicalPtyBinding(
      { surfaces, sessions, reader: runtime.workspaceSurfaces },
      resolved,
      binding,
      fence
    )
  }
  const publish = (session: WorkspaceSessionState): void => {
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSession = session
    } else {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [resolved]: session
      }
    }
    runtime.dirtyProfileStateDomains?.add(
      resolved === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
    )
  }
  return runtime.runDurableMutation(() => {
    const session = sessions.getWorkspaceSession(resolved)
    const currentId =
      session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    if (!currentId) {
      return { value: true, persist: 'if-dirty' }
    }
    if (currentId !== binding.ptyId) {
      return { value: false, persist: false }
    }
    if (
      fence &&
      session.terminalPtyIncarnationsByPaneKey?.[makePaneKey(binding.tabId, binding.leafId)] !==
        fence.incarnationId
    ) {
      return { value: false, persist: false }
    }
    if (!session.tabsByWorktree[binding.worktreeId]?.some((tab) => tab.id === binding.tabId)) {
      return { value: false, persist: false }
    }
    const before = cloneWorkspaceSessionState(session)
    const retired = clearReplacedPaneBinding(session, { ...binding, parentTabId: binding.tabId })
    // Publish directly: renderer snapshot repair would revive the retired binding.
    publish(retired)
    bumpPtyBindingGeneration(runtime, resolved, binding.leafId)
    const staged = cloneWorkspaceSessionState(retired)
    return {
      value: true,
      writtenHostIds: [resolved],
      rollback: () => {
        publish(
          rollbackWorkspaceSessionAfterFailedAsyncWrite(
            before,
            staged,
            sessions.getWorkspaceSession(resolved)
          )
        )
        bumpPtyBindingGeneration(runtime, resolved, binding.leafId)
      }
    }
  })
}
