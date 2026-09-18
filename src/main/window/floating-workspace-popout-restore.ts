import type { BrowserWindow } from 'electron'
import { screen } from 'electron'
import {
  calculateTargetDisplayBounds,
  type WorkspaceDisplayInfo
} from '../../shared/floating-workspace-display'
import { isBackgroundLaunch } from './foreground-activation-policy'

const MINIMIZED_COORD_SENTINEL = -10000
const RESTORE_SETTLE_MS = 200
const RESTORE_REPOSITION_MS = 60
const RESTORE_CONFIRM_MS = 150

let lastKnownBounds: Electron.Rectangle | null = null
let lastKnownDisplayId: number | null = null
let minimizedDisplayId: number | null = null
let minimizedBounds: Electron.Rectangle | null = null
let wasMaximizedBeforeMinimize = false
let isRestoring = false
let restoreTimeoutId: NodeJS.Timeout | null = null

type PopoutRestoreHandlers = {
  updateState: () => void
  onMinimize: () => void
  onRestore: () => void
}
const restoreHandlersByWindow = new WeakMap<BrowserWindow, PopoutRestoreHandlers>()
let restoreTrackedWindow: BrowserWindow | null = null

function detachPopoutRestoreTracking(window: BrowserWindow): void {
  const handlers = restoreHandlersByWindow.get(window)
  if (!handlers) {
    return
  }
  restoreHandlersByWindow.delete(window)
  if (typeof window.removeListener !== 'function') {
    return
  }
  try {
    window.removeListener('moved', handlers.updateState)
    window.removeListener('resize', handlers.updateState)
    window.removeListener('minimize', handlers.onMinimize)
    window.removeListener('restore', handlers.onRestore)
  } catch {
    // ignore
  }
}

function resolveRestoreTarget(
  displays: readonly WorkspaceDisplayInfo[]
): WorkspaceDisplayInfo | undefined {
  const targetId = minimizedDisplayId ?? lastKnownDisplayId
  return (
    (targetId != null ? displays.find((d) => d.id === targetId) : null) ??
    displays.find((d) => !d.isPrimary) ??
    displays[0]
  )
}

function placeMaximizedOnDisplay(window: BrowserWindow, targetDisplay: WorkspaceDisplayInfo): void {
  if (typeof window.unmaximize === 'function') {
    window.unmaximize()
  }
  if (typeof window.setBounds === 'function') {
    window.setBounds(calculateTargetDisplayBounds(targetDisplay))
  }
  if (typeof window.maximize === 'function') {
    window.maximize()
  }
}

function resolveRestoreBounds(targetDisplay: WorkspaceDisplayInfo): Electron.Rectangle {
  const bounds = minimizedBounds ?? lastKnownBounds
  if (bounds) {
    try {
      if (screen.getDisplayMatching(bounds).id === targetDisplay.id) {
        return bounds
      }
    } catch {
      // ignore
    }
  }
  return calculateTargetDisplayBounds(targetDisplay, {
    currentBounds: bounds ?? undefined
  })
}

export function resetPopoutRestoreState(): void {
  if (restoreTrackedWindow) {
    detachPopoutRestoreTracking(restoreTrackedWindow)
    restoreTrackedWindow = null
  }
  lastKnownBounds = null
  lastKnownDisplayId = null
  minimizedDisplayId = null
  minimizedBounds = null
  wasMaximizedBeforeMinimize = false
  isRestoring = false
  if (restoreTimeoutId) {
    clearTimeout(restoreTimeoutId)
    restoreTimeoutId = null
  }
}

export function setPopoutDisplayTarget(
  displayId: number,
  bounds: Electron.Rectangle,
  isMaximized: boolean
): void {
  lastKnownDisplayId = displayId
  lastKnownBounds = bounds
  wasMaximizedBeforeMinimize = isMaximized
}

export function getLastKnownDisplayId(): number | null {
  return lastKnownDisplayId
}

export function isPopoutRestoring(): boolean {
  return isRestoring
}

export function getPopoutCurrentDisplayId(window: BrowserWindow): number | null {
  try {
    const isMin = typeof window.isMinimized === 'function' ? window.isMinimized() : false
    if (isMin || isRestoring || minimizedDisplayId != null) {
      return lastKnownDisplayId
    }
    if (typeof window.getBounds !== 'function') {
      return lastKnownDisplayId
    }
    const bounds = window.getBounds()
    if (bounds.x <= MINIMIZED_COORD_SENTINEL || bounds.y <= MINIMIZED_COORD_SENTINEL) {
      return lastKnownDisplayId
    }
    return screen.getDisplayMatching(bounds).id
  } catch {
    return lastKnownDisplayId
  }
}

export function repositionPopoutToDisplay(
  window: BrowserWindow,
  displays: readonly WorkspaceDisplayInfo[]
): void {
  if (window.isDestroyed() || typeof window.getBounds !== 'function') {
    isRestoring = false
    return
  }
  const currentBounds = window.getBounds()
  if (currentBounds.x <= MINIMIZED_COORD_SENTINEL || currentBounds.y <= MINIMIZED_COORD_SENTINEL) {
    return
  }

  const targetDisplay = resolveRestoreTarget(displays)
  if (!targetDisplay) {
    isRestoring = false
    return
  }

  let currentDisplayId: number | null = null
  try {
    currentDisplayId = screen.getDisplayMatching(currentBounds).id
  } catch {
    // ignore
  }

  const isWrongDisplay = currentDisplayId !== targetDisplay.id
  const isCurrentlyMax = typeof window.isMaximized === 'function' ? window.isMaximized() : false
  const shouldBeMax = wasMaximizedBeforeMinimize || isCurrentlyMax

  if (shouldBeMax) {
    if (isWrongDisplay) {
      placeMaximizedOnDisplay(window, targetDisplay)
    }
  } else {
    const bounds = resolveRestoreBounds(targetDisplay)
    if (isWrongDisplay || lastKnownBounds || minimizedBounds) {
      if (typeof window.setBounds === 'function') {
        window.setBounds(bounds)
      }
    }
  }
}

export function restorePopoutWindow(
  window: BrowserWindow,
  displays: readonly WorkspaceDisplayInfo[]
): boolean {
  const targetDisplay = resolveRestoreTarget(displays)
  if (!targetDisplay) {
    minimizedDisplayId = null
    minimizedBounds = null
    isRestoring = false
    return false
  }
  isRestoring = true
  const isMin = typeof window.isMinimized === 'function' ? window.isMinimized() : false
  if (isMin && typeof window.restore === 'function') {
    window.restore()
  }

  const isCurrentlyMax = typeof window.isMaximized === 'function' ? window.isMaximized() : false
  const shouldBeMax = wasMaximizedBeforeMinimize || isCurrentlyMax
  if (shouldBeMax) {
    placeMaximizedOnDisplay(window, targetDisplay)
  } else if (typeof window.setBounds === 'function') {
    window.setBounds(resolveRestoreBounds(targetDisplay))
  }
  if (!isBackgroundLaunch() && typeof window.focus === 'function') {
    window.focus()
  }
  if (restoreTimeoutId) {
    clearTimeout(restoreTimeoutId)
    restoreTimeoutId = null
  }
  restoreTimeoutId = setTimeout(() => {
    minimizedDisplayId = null
    minimizedBounds = null
    isRestoring = false
    restoreTimeoutId = null
  }, RESTORE_SETTLE_MS)
  return true
}

export function recordPopoutMinimize(window: BrowserWindow): void {
  const isMax = typeof window.isMaximized === 'function' ? window.isMaximized() : false
  wasMaximizedBeforeMinimize = isMax
  try {
    if (typeof window.getBounds === 'function') {
      const bounds = window.getBounds()
      if (bounds.x > MINIMIZED_COORD_SENTINEL && bounds.y > MINIMIZED_COORD_SENTINEL) {
        lastKnownDisplayId = screen.getDisplayMatching(bounds).id
        if (!isMax) {
          lastKnownBounds = bounds
        }
      }
    }
  } catch {
    // ignore
  }
  minimizedDisplayId = lastKnownDisplayId
  minimizedBounds = lastKnownBounds
  isRestoring = true
}

export function installPopoutRestoreTracking(
  window: BrowserWindow,
  getDisplays: () => readonly WorkspaceDisplayInfo[]
): void {
  try {
    if (typeof window.getBounds === 'function') {
      const bounds = window.getBounds()
      if (bounds.x > MINIMIZED_COORD_SENTINEL && bounds.y > MINIMIZED_COORD_SENTINEL) {
        lastKnownBounds = bounds
        lastKnownDisplayId = screen.getDisplayMatching(bounds).id
      }
    }
  } catch {
    // noop
  }

  if (typeof window.on !== 'function') {
    return
  }
  if (restoreTrackedWindow && restoreTrackedWindow !== window) {
    detachPopoutRestoreTracking(restoreTrackedWindow)
  }
  restoreTrackedWindow = window
  if (restoreHandlersByWindow.has(window)) {
    return
  }

  const updateState = (): void => {
    if (isRestoring || minimizedDisplayId != null || window.isDestroyed()) {
      return
    }
    const isMin = typeof window.isMinimized === 'function' ? window.isMinimized() : false
    if (isMin || typeof window.getBounds !== 'function') {
      return
    }
    const bounds = window.getBounds()
    if (bounds.x <= MINIMIZED_COORD_SENTINEL || bounds.y <= MINIMIZED_COORD_SENTINEL) {
      return
    }
    const isMax = typeof window.isMaximized === 'function' ? window.isMaximized() : false
    wasMaximizedBeforeMinimize = isMax
    try {
      lastKnownDisplayId = screen.getDisplayMatching(bounds).id
    } catch {
      // ignore
    }
    if (!isMax) {
      lastKnownBounds = bounds
    }
  }

  const onMinimize = (): void => {
    if (!window.isDestroyed()) {
      recordPopoutMinimize(window)
    }
  }

  const onRestore = (): void => {
    isRestoring = true
    repositionPopoutToDisplay(window, getDisplays())
    if (restoreTimeoutId) {
      clearTimeout(restoreTimeoutId)
      restoreTimeoutId = null
    }
    restoreTimeoutId = setTimeout(() => {
      repositionPopoutToDisplay(window, getDisplays())
      restoreTimeoutId = setTimeout(() => {
        repositionPopoutToDisplay(window, getDisplays())
        minimizedDisplayId = null
        minimizedBounds = null
        isRestoring = false
        restoreTimeoutId = null
        updateState()
      }, RESTORE_CONFIRM_MS)
    }, RESTORE_REPOSITION_MS)
  }

  window.on('moved', updateState)
  window.on('resize', updateState)
  window.on('minimize', onMinimize)
  window.on('restore', onRestore)
  restoreHandlersByWindow.set(window, { updateState, onMinimize, onRestore })
}
