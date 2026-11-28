// macOS recreates windows after Dock activation; process-global subscribers survive and each new window relays show/restore here.
type MainWindowBecameVisibleListener = () => void

type MainWindowVisibilityState = {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  isMinimized?: () => boolean
}

function createMainWindowSignal(): {
  notify: () => void
  subscribe: (listener: MainWindowBecameVisibleListener) => () => void
} {
  const listeners = new Set<MainWindowBecameVisibleListener>()
  return {
    notify: () => {
      for (const listener of Array.from(listeners)) {
        listener()
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const becameVisible = createMainWindowSignal()
const focused = createMainWindowSignal()
const hidden = createMainWindowSignal()

export const notifyMainWindowBecameVisible = becameVisible.notify
export const onMainWindowBecameVisible = becameVisible.subscribe
export const notifyMainWindowFocused = focused.notify
export const onMainWindowFocused = focused.subscribe
export const notifyMainWindowHidden = hidden.notify
export const onMainWindowHidden = hidden.subscribe

export function isMainWindowVisible(window: MainWindowVisibilityState | null): boolean {
  if (window === null || window.isDestroyed()) {
    return false
  }

  // Minimal older window doubles lack visibility APIs; default them to visible.
  const isVisible = window.isVisible?.() ?? true
  const isMinimized = window.isMinimized?.() ?? false
  return isVisible && !isMinimized
}
