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

// Why: iOS cannot reliably present a second native modal until the first drawer's
// exit commits; one extra frame keeps transitions sequential on slower devices.
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

  // Why: cancel any queued transition and reset when the modal closes, so a
  // timer can't land after close and leave a stale drawer for the next open.
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
    // Why: same-beat open; the form stays mounted underneath so the outer
    // content height is preserved when the fill picker dismisses.
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
