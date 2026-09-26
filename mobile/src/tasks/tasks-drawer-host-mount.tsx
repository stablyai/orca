import { useCallback, useState, type ReactNode } from 'react'
import { BottomDrawerModalHost } from '../components/bottom-drawer-modal-host'

type Props = {
  openCount: number
  onRequestClose: () => void
  children: ReactNode
}

function useTasksDrawerHostMounted(openCount: number): {
  mounted: boolean
  notifyDrawerAfterClose: () => void
  notifyDrawerCloseCancelled: () => void
} {
  const [mounted, setMounted] = useState(openCount > 0)
  const [pendingCloses, setPendingCloses] = useState(0)
  const [seenOpenCount, setSeenOpenCount] = useState(openCount)

  if (openCount !== seenOpenCount) {
    const closed = seenOpenCount - openCount
    setSeenOpenCount(openCount)
    if (openCount > 0) {
      setMounted(true)
    }
    if (closed > 0) {
      setPendingCloses((pending) => pending + closed)
    }
  } else if (mounted && openCount === 0 && pendingCloses === 0) {
    setMounted(false)
  }

  const notifyDrawerAfterClose = useCallback(() => {
    setPendingCloses((pending) => (pending > 0 ? pending - 1 : 0))
  }, [])

  const notifyDrawerCloseCancelled = useCallback(() => {
    setPendingCloses((pending) => (pending > 0 ? pending - 1 : 0))
  }, [])

  return { mounted, notifyDrawerAfterClose, notifyDrawerCloseCancelled }
}

// Why: dropping the host when the last sheet closes skips that sheet's exit animation.
export function TasksDrawerModalHost({ openCount, onRequestClose, children }: Props) {
  const { mounted, notifyDrawerAfterClose, notifyDrawerCloseCancelled } =
    useTasksDrawerHostMounted(openCount)
  return (
    <BottomDrawerModalHost
      visible={mounted}
      onRequestClose={onRequestClose}
      onChildAfterClose={notifyDrawerAfterClose}
      onChildCloseCancelled={notifyDrawerCloseCancelled}
    >
      {children}
    </BottomDrawerModalHost>
  )
}
