import { useCallback, useRef, useState } from 'react'
import { worktreeRemove } from '../host-screen/host-screen-operations'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useMobileSendCompletionGeneration } from './use-mobile-send-completion-generation'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

export function useMobileSessionDeleteAction({
  client,
  connState,
  hostId,
  worktreeId,
  isFloatingWorkspaceRoute,
  router,
  setShowHeaderMoreActions,
  showToast
}: Pick<
  MobileSessionPresentationModel,
  | 'client'
  | 'connState'
  | 'hostId'
  | 'worktreeId'
  | 'isFloatingWorkspaceRoute'
  | 'router'
  | 'setShowHeaderMoreActions'
  | 'showToast'
>) {
  const executionHost = useWorkspaceExecutionHost()
  const deleteWorkspaceScope = JSON.stringify([hostId, executionHost, worktreeId])
  const closeMenu = useCallback(() => setShowHeaderMoreActions(false), [setShowHeaderMoreActions])
  const getCompletionGeneration = useMobileSendCompletionGeneration({
    surfaceKey: deleteWorkspaceScope,
    onBlur: closeMenu
  })
  const deletingRef = useRef(false)
  const [deletingWorkspace, setDeletingWorkspace] = useState(false)

  const handleDeleteWorkspace = async () => {
    if (
      !client ||
      connState !== 'connected' ||
      client.getState() !== 'connected' ||
      isFloatingWorkspaceRoute ||
      deletingRef.current
    ) {
      return
    }
    deletingRef.current = true
    setDeletingWorkspace(true)
    const generation = getCompletionGeneration()
    try {
      const reply = await worktreeRemove.request(client, {
        worktree: `id:${worktreeId}`,
        force: true
      })
      if (generation !== getCompletionGeneration()) {
        return
      }
      if (!worktreeRemove.interpret(reply).accepted) {
        showToast("Couldn't delete workspace. Try again.", 2500)
        return
      }
      router.replace(`/h/${encodeURIComponent(hostId)}`)
    } catch {
      if (generation === getCompletionGeneration()) {
        showToast("Couldn't delete workspace. Try again.", 2500)
      }
    } finally {
      deletingRef.current = false
      setDeletingWorkspace(false)
    }
  }

  return {
    deleteWorkspaceScope,
    handleDeleteWorkspace,
    deleteWorkspaceDisabled: !client || connState !== 'connected' || deletingWorkspace
  }
}
