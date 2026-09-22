import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'

import type { RpcClient } from '../transport/rpc-client'
import { NewWorktreeModal } from './NewWorktreeModal'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

export type NewWorktreeModalControllerHandle = {
  /** Opens the form; a repo passed here is upserted and selected for the new session. */
  open: (preselectedRepo?: MobileWorkspaceRepo) => void
}

type Props = {
  routeVisible: boolean
  client: RpcClient | null
  hostId?: string
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  openExternalUrl: (url: string) => void
  onVisibleChange?: (visible: boolean) => void
  onRouteVisibleChange: (visible: boolean) => void
  onCreated: (worktreeId: string, name: string, warning?: string) => void
}

export const NewWorktreeModalController = forwardRef<NewWorktreeModalControllerHandle, Props>(
  function NewWorktreeModalController(
    {
      routeVisible,
      client,
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
    // Why: state, not an argument — the handle is a stable ref, so the preselection must
    // survive to the render that flips `manualVisible` and mounts the session for it.
    const [preselectedRepo, setPreselectedRepo] = useState<MobileWorkspaceRepo | null>(null)
    const visible = routeVisible || manualVisible

    useImperativeHandle(
      ref,
      () => ({
        open: (repo) => {
          setPreselectedRepo(repo ?? null)
          setManualVisible(true)
        }
      }),
      []
    )

    const close = useCallback(() => {
      setManualVisible(false)
      setPreselectedRepo(null)
      if (routeVisible) {
        onRouteVisibleChange(false)
      }
    }, [onRouteVisibleChange, routeVisible])

    useEffect(() => {
      onVisibleChange?.(visible)
    }, [onVisibleChange, visible])

    // Why: pass the preselection only while a manual open is pending — a route-driven
    // opening must keep the last-visited default rather than a stale handoff repo.
    return (
      <NewWorktreeModal
        visible={visible}
        client={client}
        hostId={hostId}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={existingWorktrees}
        preselectedRepo={manualVisible ? preselectedRepo : null}
        openExternalUrl={openExternalUrl}
        onCreated={onCreated}
        onClose={close}
      />
    )
  }
)
