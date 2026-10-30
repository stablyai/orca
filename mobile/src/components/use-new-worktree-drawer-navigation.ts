import { useEffect, useRef, useState } from 'react'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'
import { resolveNewWorktreeFormSheetVisible } from './new-worktree-form-sheet-visibility'

export type NewWorktreeDrawerView =
  | 'form'
  | 'transition'
  | 'source'
  | 'project'
  | 'runTarget'
  | 'agent'
  | 'trust'

// iOS needs the first modal’s exit committed before presenting another; wait an extra frame on slower devices.
const NEW_WORKTREE_DRAWER_TRANSITION_MS = BOTTOM_DRAWER_HIDE_DURATION_MS + 16

export function useNewWorktreeDrawerNavigation(modalVisible: boolean): {
  drawerView: NewWorktreeDrawerView
  formSheetVisible: boolean
  formSheetInteractive: boolean
  transitionDrawer: (nextView: Exclude<NewWorktreeDrawerView, 'transition'>) => void
  openSourceDrawer: () => void
} {
  const [drawerView, setDrawerView] = useState<NewWorktreeDrawerView>('form')
  const drawerTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel queued transitions on close so the next open cannot inherit a stale drawer.
  useEffect(() => {
    if (modalVisible) {
      return
    }
    if (drawerTransitionTimerRef.current) {
      clearTimeout(drawerTransitionTimerRef.current)
      drawerTransitionTimerRef.current = null
    }
    setDrawerView('form')
  }, [modalVisible])

  useEffect(() => {
    return () => {
      if (drawerTransitionTimerRef.current) {
        clearTimeout(drawerTransitionTimerRef.current)
      }
    }
  }, [])

  function transitionDrawer(nextView: Exclude<NewWorktreeDrawerView, 'transition'>): void {
    if (drawerTransitionTimerRef.current) {
      clearTimeout(drawerTransitionTimerRef.current)
    }
    setDrawerView('transition')
    drawerTransitionTimerRef.current = setTimeout(() => {
      drawerTransitionTimerRef.current = null
      setDrawerView(nextView)
    }, NEW_WORKTREE_DRAWER_TRANSITION_MS)
  }

  function openSourceDrawer(): void {
    // Keep the form mounted under the picker to preserve the outer content height.
    if (drawerTransitionTimerRef.current) {
      clearTimeout(drawerTransitionTimerRef.current)
    }
    drawerTransitionTimerRef.current = null
    setDrawerView('source')
  }

  return {
    drawerView,
    formSheetVisible: resolveNewWorktreeFormSheetVisible({ modalVisible, drawerView }),
    formSheetInteractive: drawerView === 'form',
    transitionDrawer,
    openSourceDrawer
  }
}
