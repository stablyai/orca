import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type SetStateAction
} from 'react'
import {
  TOGGLE_FLOATING_TERMINAL_EVENT,
  requestFloatingTerminalOpenMaximized
} from '@/lib/floating-terminal'
import { createFloatingWorkspaceTourInteractionSnapshot } from '@/lib/floating-workspace-tour-interaction-snapshot'
import { persistFloatingTerminalPanelOpen } from '../components/floating-terminal/floating-terminal-panel-view-state'
import { useAppStore } from '../store'
import { selectFloatingVisibleTabCount } from '../store/selectors'

export type FloatingWorkspacePanelState = ReturnType<typeof useFloatingWorkspacePanel>

/** Persist floating-overlay state and return focus on close, including external toggle/disable requests. */
export function useFloatingWorkspacePanel() {
  const open = useAppStore((s) => s.floatingWorkspacePanelOpen)
  const setOpen = useAppStore((s) => s.setFloatingWorkspacePanelOpen)
  const tourInteractionSnapshotRef = useRef<{
    wasPreviouslyInteracted?: boolean
    persisted?: Promise<void>
    recordFeatureInteractionForTour: boolean
  } | null>(null)

  const enabled = useAppStore((s) => s.settings?.floatingTerminalEnabled === true)
  // Unhydrated null settings are not a user disable; wait for the atomic settings replacement.
  const settingsHydrated = useAppStore((s) => s.settings != null)
  const triggerLocation = useAppStore(
    (s) => s.settings?.floatingTerminalTriggerLocation ?? 'floating-button'
  )
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const visibleTabCount = useAppStore(selectFloatingVisibleTabCount)

  // Return focus to the prior surface when hotkey-minimizing the overlay.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const returnFocusFrameRef = useRef<number | null>(null)

  const cancelReturnFocusFrame = useCallback((): void => {
    if (returnFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(returnFocusFrameRef.current)
    returnFocusFrameRef.current = null
  }, [])

  const rememberReturnFocus = useCallback((): void => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      returnFocusRef.current = null
      return
    }
    if (
      active.closest('[data-floating-terminal-panel]') ||
      active.closest('[data-floating-terminal-toggle]')
    ) {
      return
    }
    returnFocusRef.current = active
  }, [])

  const restoreReturnFocus = useCallback((): void => {
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (!target || !document.contains(target)) {
      return
    }
    cancelReturnFocusFrame()
    returnFocusFrameRef.current = requestAnimationFrame(() => {
      returnFocusFrameRef.current = null
      if (!document.contains(target)) {
        return
      }
      target.focus({ preventScroll: true })
    })
  }, [cancelReturnFocusFrame])

  const setOpenWithFocus = useCallback(
    (nextOpen: SetStateAction<boolean>): void => {
      const resolvedOpen = typeof nextOpen === 'function' ? nextOpen(open) : nextOpen
      // Telemetry updates Zustand; keep it outside the updater to avoid render-phase writes.
      if (resolvedOpen && !open) {
        tourInteractionSnapshotRef.current = createFloatingWorkspaceTourInteractionSnapshot(
          useAppStore.getState()
        )
        rememberReturnFocus()
      } else if (!resolvedOpen && open) {
        restoreReturnFocus()
      }
      setOpen(resolvedOpen)
      // Persist only an enabled panel; an unhydrated flag must not overwrite restored open state.
      if (enabled) {
        persistFloatingTerminalPanelOpen(resolvedOpen)
      }
    },
    [enabled, open, setOpen, rememberReturnFocus, restoreReturnFocus]
  )

  const openMaximized = useCallback((): void => {
    requestFloatingTerminalOpenMaximized()
    setOpenWithFocus(true)
  }, [setOpenWithFocus])

  // Why layout: enable-then-toggle callers dispatch a frame later, which a passive rebind can miss.
  useLayoutEffect(() => {
    const toggleFloatingTerminal = (): void => {
      if (enabled) {
        setOpenWithFocus((current) => !current)
      }
    }
    window.addEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
    return () => window.removeEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, toggleFloatingTerminal)
  }, [enabled, setOpenWithFocus])

  useEffect(() => {
    // Only hydrated flag-off means disable; closing during settings load would discard restored open state.
    if (settingsHydrated && !enabled) {
      setOpenWithFocus(false)
    }
  }, [settingsHydrated, enabled, setOpenWithFocus])

  const shouldMountPanel = enabled && (open || visibleTabCount > 0)
  const showToggleButton = enabled && (triggerLocation === 'floating-button' || !statusBarVisible)
  // Stable identity lets memoized root surfaces skip the App render each workspace switch causes.
  return useMemo(
    () => ({
      cancelReturnFocusFrame,
      enabled,
      open,
      openMaximized,
      setOpenWithFocus,
      // Retain panes’ local state while closed once the floating workspace owns tabs.
      shouldMountPanel,
      showToggleButton,
      tourInteractionSnapshotRef,
      visibleTabCount
    }),
    [
      cancelReturnFocusFrame,
      enabled,
      open,
      openMaximized,
      setOpenWithFocus,
      shouldMountPanel,
      showToggleButton,
      visibleTabCount
    ]
  )
}
