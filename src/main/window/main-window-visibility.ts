// Why: BrowserWindow instances are recreated on macOS dock re-activation, so
// long-lived main-process services (e.g. the SSH port scanner) subscribe to
// this process-global signal instead of a specific window instance; index.ts
// re-wires each new window's show/restore events into notifyMainWindowBecameVisible.
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

  // Why: production BrowserWindow exposes both APIs, but older main-process
  // tests use minimal window doubles that should stay visible by default.
  const isVisible = window.isVisible?.() ?? true
  const isMinimized = window.isMinimized?.() ?? false
  return isVisible && !isMinimized
}
