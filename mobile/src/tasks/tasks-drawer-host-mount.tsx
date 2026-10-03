import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BottomDrawerModalHost } from '../components/bottom-drawer-modal-host'

type Props = {
  openCount: number
  onRequestClose: () => void
  children: ReactNode
}

function useTasksDrawerHostMounted(openCount: number): {
  mounted: boolean
  notifyDrawerCloseStarted: () => void
  notifyDrawerAfterClose: () => void
  notifyDrawerCloseCancelled: () => void
} {
  const [mounted, setMounted] = useState(openCount > 0)
  const pendingCloses = useRef(0)
  const latestOpenCount = useRef(openCount)
  latestOpenCount.current = openCount

  if (openCount > 0 && !mounted) {
    setMounted(true)
  }

  // Child close-start effects run before this host effect, so the final drawer gets
  // counted before an empty host can unmount.
  useEffect(() => {
    if (openCount === 0 && pendingCloses.current === 0) {
      setMounted(false)
    }
  }, [openCount])

  const notifyDrawerCloseStarted = useCallback(() => {
    pendingCloses.current += 1
  }, [])

  const notifyDrawerCloseSettled = useCallback(() => {
    pendingCloses.current = Math.max(0, pendingCloses.current - 1)
    if (latestOpenCount.current === 0 && pendingCloses.current === 0) {
      setMounted(false)
    }
  }, [])

  return {
    mounted,
    notifyDrawerCloseStarted,
    notifyDrawerAfterClose: notifyDrawerCloseSettled,
    notifyDrawerCloseCancelled: notifyDrawerCloseSettled
  }
}

// Why: dropping the host when the last sheet closes skips that sheet's exit animation.
export function TasksDrawerModalHost({ openCount, onRequestClose, children }: Props) {
  const { mounted, notifyDrawerCloseStarted, notifyDrawerAfterClose, notifyDrawerCloseCancelled } =
    useTasksDrawerHostMounted(openCount)
  return (
    <BottomDrawerModalHost
      visible={mounted}
      onRequestClose={onRequestClose}
      onChildAfterClose={notifyDrawerAfterClose}
      onChildCloseStarted={notifyDrawerCloseStarted}
      onChildCloseCancelled={notifyDrawerCloseCancelled}
    >
      {children}
    </BottomDrawerModalHost>
  )
}
