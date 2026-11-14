import { useEffect } from 'react'
import { useAppStore } from '../store'
import { closeUnpinnedEditorTabs } from '@/lib/workspace/tabs/unpinned-editor-tabs'

const FOCUS_ZONE_SELECTOR = '[data-tab-focus-zone]'
const OVERLAY_SELECTOR =
  '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]'

/** Closes clean unpinned editor tabs when in-app focus leaves the tab bar or editor. */
export function useCloseUnpinnedEditorTabsOnFocusLoss(): void {
  useEffect(() => {
    let pointerStartedInZone = false

    const onPointerDown = (event: PointerEvent): void => {
      pointerStartedInZone =
        event.target instanceof Element && event.target.closest(FOCUS_ZONE_SELECTOR) !== null
    }

    const onFocusOut = (event: FocusEvent): void => {
      if (useAppStore.getState().settings?.closeUnpinnedEditorTabsOnFocusLoss !== true) {
        return
      }
      const from = event.target
      // Why: a detached target is a tab or view being removed, not focus leaving the editor.
      if (!(from instanceof Element) || !from.isConnected || !from.closest(FOCUS_ZONE_SELECTOR)) {
        return
      }
      const to = event.relatedTarget
      if (to instanceof Element) {
        if (to.closest(FOCUS_ZONE_SELECTOR) || to.closest(OVERLAY_SELECTOR)) {
          return
        }
      } else if (pointerStartedInZone) {
        // Why: a click on empty space inside the editor moves focus to body without leaving it.
        return
      }
      // Why: run after the blur settles; a window switch also reports focusout with no target.
      window.setTimeout(() => {
        if (!document.hasFocus()) {
          return
        }
        const focused = document.activeElement
        if (focused?.closest(FOCUS_ZONE_SELECTOR) || focused?.closest(OVERLAY_SELECTOR)) {
          return
        }
        const worktreeId = useAppStore.getState().activeWorktreeId
        if (worktreeId) {
          closeUnpinnedEditorTabs(worktreeId)
        }
      }, 0)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
