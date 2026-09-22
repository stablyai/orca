import { useEffect, useRef, useState } from 'react'
import { resolveMountedLazyModalIds, type LazyModalId } from '../lazy-modal-mount-state'
import { useAppStore } from '../store'

/**
 * Tracks which lazy modal chunks are mounted. Modals load on first use and then stay mounted
 * so repeat opens preserve state and avoid re-fetch flashes.
 */
export function useLazyModalMounts(): {
  mountedLazyModalIds: ReadonlySet<LazyModalId>
  shouldMountAddRepoDialog: boolean
} {
  const activeModal = useAppStore((s) => s.activeModal)
  const [mountedLazyModalIds, setMountedLazyModalIds] = useState<Set<LazyModalId>>(() => new Set())
  const [shouldMountAddRepoDialog, setShouldMountAddRepoDialog] = useState(false)
  const unmountAddRepoDialogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (activeModal === 'add-repo') {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
      setShouldMountAddRepoDialog(true)
      return
    }
    if (shouldMountAddRepoDialog && !unmountAddRepoDialogTimerRef.current) {
      // Why: AddRepoDialog's close effect aborts in-flight clone work; keep one closed render before unmounting hidden SSH/remote subscriptions.
      unmountAddRepoDialogTimerRef.current = setTimeout(() => {
        setShouldMountAddRepoDialog(false)
        unmountAddRepoDialogTimerRef.current = null
      }, 0)
    }
    return () => {
      if (unmountAddRepoDialogTimerRef.current) {
        clearTimeout(unmountAddRepoDialogTimerRef.current)
        unmountAddRepoDialogTimerRef.current = null
      }
    }
  }, [activeModal, shouldMountAddRepoDialog])

  const resolvedMountedLazyModalIds = resolveMountedLazyModalIds(activeModal, mountedLazyModalIds)
  if (resolvedMountedLazyModalIds !== mountedLazyModalIds) {
    setMountedLazyModalIds(new Set(resolvedMountedLazyModalIds))
  }

  return { mountedLazyModalIds: resolvedMountedLazyModalIds, shouldMountAddRepoDialog }
}
