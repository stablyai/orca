import { useEffect, useRef } from 'react'
import { useCompactViewport } from '@/lib/compact-viewport'
import { useAppStore } from '../store'

/**
 * On a phone-width viewport both sidebars are drawers over the content, so they start closed
 * (including after hydration restores a desktop-open right sidebar) and the left one closes once
 * the user has picked where to go.
 */
export function useCompactShellDrawers(): boolean {
  const compact = useCompactViewport()
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  useEffect(() => {
    if (!compact) {
      return
    }
    const { setSidebarOpen, setRightSidebarOpen } = useAppStore.getState()
    setSidebarOpen(false)
    setRightSidebarOpen(false)
  }, [compact, persistedUIReady])

  const lastDestination = useRef({ activeView, activeWorktreeId })
  useEffect(() => {
    const previous = lastDestination.current
    lastDestination.current = { activeView, activeWorktreeId }
    if (!compact) {
      return
    }
    if (previous.activeView !== activeView || previous.activeWorktreeId !== activeWorktreeId) {
      useAppStore.getState().setSidebarOpen(false)
    }
  }, [compact, activeView, activeWorktreeId])

  return compact
}
