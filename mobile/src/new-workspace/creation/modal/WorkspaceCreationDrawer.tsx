import { useState, type ComponentProps } from 'react'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { NewWorkspaceLoadingCover } from '../../NewWorkspaceLoadingCover'

type Props = ComponentProps<typeof BottomDrawer> & {
  ready: boolean
  onCancelLoading: () => void
}

export function WorkspaceCreationDrawer({ ready, visible, onCancelLoading, ...drawer }: Props) {
  const [opened, setOpened] = useState(false)
  const [waited, setWaited] = useState(false)
  if (visible && ready && !opened) {
    setOpened(true)
  }
  if (visible && !ready && !opened && !waited) {
    setWaited(true)
  }
  // Once presented, tab switches and refreshes resize the same drawer.
  const shown = visible && (opened || ready)
  return (
    <>
      <BottomDrawer {...drawer} visible={shown} />
      {waited && (
        <NewWorkspaceLoadingCover
          visible={visible && !shown}
          download={null}
          onCancel={onCancelLoading}
        />
      )}
    </>
  )
}
