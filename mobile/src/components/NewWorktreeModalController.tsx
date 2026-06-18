import { forwardRef, useCallback, useImperativeHandle, useState } from 'react'

import type { RpcClient } from '../transport/rpc-client'
import { NewWorktreeModal } from './NewWorktreeModal'

export type NewWorktreeModalControllerHandle = {
  open: () => void
}

type Props = {
  routeVisible: boolean
  client: RpcClient | null
  hostId?: string
  existingWorktreePaths?: readonly string[]
  onRouteVisibleChange: (visible: boolean) => void
  onCreated: (worktreeId: string, name: string) => void
}

export const NewWorktreeModalController = forwardRef<NewWorktreeModalControllerHandle, Props>(
  function NewWorktreeModalController(
    { routeVisible, client, hostId, existingWorktreePaths, onRouteVisibleChange, onCreated },
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

    return (
      <NewWorktreeModal
        visible={visible}
        client={client}
        hostId={hostId}
        existingWorktreePaths={existingWorktreePaths}
        onCreated={onCreated}
        onClose={close}
      />
    )
  }
)
