import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'

import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import type { HostScreenShellOperations } from '../worktree/host-screen-shell-operations'
import { NewWorktreeModal } from './NewWorktreeModal'

export type NewWorktreeModalControllerHandle = {
  open: () => void
}

type Props = {
  routeVisible: boolean
  operations: HostWorkspaceCreationOperations | null
  hostId?: string
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  openExternalUrl: HostScreenShellOperations['openExternalUrl']
  onVisibleChange?: (visible: boolean) => void
  onRouteVisibleChange: (visible: boolean) => void
  onCreated: (worktreeId: string, name: string) => void
}

export const NewWorktreeModalController = forwardRef<NewWorktreeModalControllerHandle, Props>(
  function NewWorktreeModalController(
    {
      routeVisible,
      operations,
      hostId,
      existingWorktreePaths,
      existingWorktrees,
      openExternalUrl,
      onVisibleChange,
      onRouteVisibleChange,
      onCreated
    },
    ref
  ) {
    const [manualVisible, setManualVisible] = useState(false)
    const visible = routeVisible || manualVisible

    useImperativeHandle(
      ref,
      () => ({
        open: () => setManualVisible(true)
      }),
      []
    )

    const close = useCallback(() => {
      setManualVisible(false)
      if (routeVisible) {
        onRouteVisibleChange(false)
      }
    }, [onRouteVisibleChange, routeVisible])

    useEffect(() => {
      onVisibleChange?.(visible)
    }, [onVisibleChange, visible])

    return (
      <NewWorktreeModal
        visible={visible}
        operations={operations}
        hostId={hostId}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={existingWorktrees}
        openExternalUrl={openExternalUrl}
        onCreated={onCreated}
        onClose={close}
      />
    )
  }
)
