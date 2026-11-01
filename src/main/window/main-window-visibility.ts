// macOS recreates windows after Dock activation; process-global subscribers survive and each new window relays show/restore here.
type MainWindowBecameVisibleListener = () => void

type MainWindowVisibilityState = {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  isMinimized?: () => boolean
}

const listeners = new Set<MainWindowBecameVisibleListener>()

export function notifyMainWindowBecameVisible(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

export function onMainWindowBecameVisible(listener: MainWindowBecameVisibleListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isMainWindowVisible(window: MainWindowVisibilityState | null): boolean {
  if (window === null || window.isDestroyed()) {
    return false
  }

  // Minimal older window doubles lack visibility APIs; default them to visible.
  const isVisible = window.isVisible?.() ?? true
  const isMinimized = window.isMinimized?.() ?? false
  return isVisible && !isMinimized
}
