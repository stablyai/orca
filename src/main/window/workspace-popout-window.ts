import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { KeybindingOverrides } from '../../shared/keybindings/types'
import {
  isBackgroundLaunch,
  showWindowWithoutStealingFocus
} from './activation/foreground-activation-policy'
import type { UIZoomDirection } from '../../shared/ui-zoom-level'
import type {
  WorkspacePopoutCloseReason,
  WorkspacePopoutOpenResult,
  WorkspacePopoutTarget
} from '../../shared/workspace-popout/workspace-popout-contract'
import {
  attachPopoutModuleListeners,
  detachPopoutModuleListeners,
  repatriatePopoutsToPrimaryDisplay
} from './workspace-popout/workspace-popout-module-listeners'
import {
  setupWorkspacePopoutInputRouting,
  zoomWorkspacePopout
} from './workspace-popout/workspace-popout-input-routing'
import { attachWorkspacePopoutBoundsPersistence } from './workspace-popout/workspace-popout-bounds-persistence'
import { createPopoutBrowserWindow } from './workspace-popout/workspace-popout-window-factory'

export { zoomWorkspacePopout } from './workspace-popout/workspace-popout-input-routing'
export {
  type WorkspacePopoutEntry,
  popoutsByWorktreeId,
  stateChangedListeners,
  onWorkspacePopoutStateChanged,
  broadcastPopoutStateChanged,
  isWorkspacePopoutRenderer,
  getWorkspacePopoutEntryForWebContents,
  listWorkspacePopouts,
  getWorkspacePopoutTarget,
  setWorkspacePopoutTarget
} from './workspace-popout/workspace-popout-registry'
import {
  type WorkspacePopoutEntry,
  popoutsByWorktreeId,
  stateChangedListeners,
  broadcastPopoutStateChanged,
  setWorkspacePopoutTarget
} from './workspace-popout/workspace-popout-registry'

const CRASH_WINDOW_MS = 60_000
const MAX_CRASH_RETRIES_IN_WINDOW = 2

const moduleCallbacks = {
  onBeforeQuit: () => closeAllWorkspacePopouts('app-quit'),
  onSystemResume: () => {
    for (const entry of popoutsByWorktreeId.values()) {
      if (!entry.window.isDestroyed()) {
        entry.window.webContents.send('workspacePopout:resumed')
      }
    }
  },
  onDisplayChange: () => {
    repatriatePopoutsToPrimaryDisplay(Array.from(popoutsByWorktreeId.values()).map((e) => e.window))
  }
}

export function zoomWorkspacePopoutIfFocused(direction: UIZoomDirection): boolean {
  for (const entry of popoutsByWorktreeId.values()) {
    if (!entry.window.isDestroyed() && entry.window.isFocused()) {
      zoomWorkspacePopout(entry.window, direction)
      return true
    }
  }
  return false
}

function loadWorkspacePopout(window: BrowserWindow): void {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/workspace-popout.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/workspace-popout.html'))
  }
}

export function createOrFocusWorkspacePopout(
  store: Store | null,
  target: WorkspacePopoutTarget,
  options: { getKeybindings?: () => KeybindingOverrides | undefined } = {}
): WorkspacePopoutOpenResult {
  const existing = popoutsByWorktreeId.get(target.worktreeId)
  if (existing) {
    if (existing.state === 'closing') {
      return { status: 'rejected', reason: 'closing' }
    }
    if (existing.window.isDestroyed()) {
      popoutsByWorktreeId.delete(target.worktreeId)
    } else {
      if (existing.window.isMinimized()) {
        existing.window.restore()
      }
      if (!isBackgroundLaunch()) {
        existing.window.focus()
      }
      setWorkspacePopoutTarget(target.worktreeId, target)
      return { status: 'focused' }
    }
  }

  const window = createPopoutBrowserWindow(store, target)
  const entry: WorkspacePopoutEntry = {
    worktreeId: target.worktreeId,
    target,
    window,
    state: 'opening',
    crashCount: 0,
    firstCrashTimestamp: 0
  }

  popoutsByWorktreeId.set(target.worktreeId, entry)
  if (popoutsByWorktreeId.size === 1) {
    attachPopoutModuleListeners(moduleCallbacks)
  }

  window.once('ready-to-show', () => {
    if (entry.state === 'opening') {
      entry.state = 'open'
    }
    showWindowWithoutStealingFocus(window)
  })

  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
    }
  })

  let lastFollowedZoomLevel = store?.getUI().uiZoomLevel ?? 0
  const unsubscribeUIChanged = store?.onUIChanged((ui) => {
    const level = ui.uiZoomLevel ?? 0
    if (level !== lastFollowedZoomLevel && !window.isDestroyed()) {
      lastFollowedZoomLevel = level
      window.webContents.setZoomLevel(level)
    }
  })

  const { freezeBounds } = attachWorkspacePopoutBoundsPersistence(window, store)
  setupWorkspacePopoutInputRouting(window, {
    getKeybindings: options.getKeybindings,
    onDock: () => dockWorkspacePopout(target.worktreeId)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now()
    if (now - entry.firstCrashTimestamp > CRASH_WINDOW_MS) {
      entry.firstCrashTimestamp = now
      entry.crashCount = 0
    }
    entry.crashCount++
    if (entry.crashCount <= MAX_CRASH_RETRIES_IN_WINDOW) {
      entry.state = 'recovering'
      console.warn(
        `[workspace-popout] Renderer crashed (${details.reason}), reloading attempt ${entry.crashCount}`
      )
      window.webContents.reload()
    } else {
      entry.closeReason = 'crashed'
      entry.state = 'closing'
      window.close()
    }
  })

  window.webContents.on('did-finish-load', () => {
    if (entry.state === 'recovering') {
      entry.state = 'open'
    }
  })

  let closedFired = false
  window.once('closed', () => {
    if (closedFired) {
      return
    }
    closedFired = true
    freezeBounds()
    unsubscribeUIChanged?.()
    popoutsByWorktreeId.delete(target.worktreeId)
    if (popoutsByWorktreeId.size === 0) {
      detachPopoutModuleListeners(moduleCallbacks)
    }
    broadcastPopoutStateChanged({
      worktreeId: target.worktreeId,
      tabId: entry.target.tabId,
      open: false,
      reason: entry.closeReason ?? 'window-closed'
    })
  })

  broadcastPopoutStateChanged({ worktreeId: target.worktreeId, tabId: target.tabId, open: true })
  loadWorkspacePopout(window)
  return { status: 'opened' }
}

export function focusWorkspacePopout(worktreeId: string): boolean {
  const existing = popoutsByWorktreeId.get(worktreeId)
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) {
      existing.window.restore()
    }
    if (!isBackgroundLaunch()) {
      existing.window.focus()
    }
    return true
  }
  return false
}

export function dockWorkspacePopout(worktreeId: string): void {
  const entry = popoutsByWorktreeId.get(worktreeId)
  if (!entry || entry.state === 'closing') {
    return
  }
  entry.closeReason = 'docked'
  entry.state = 'closing'
  if (!entry.window.isDestroyed()) {
    entry.window.close()
  }
}

export function closeAllWorkspacePopouts(reason: WorkspacePopoutCloseReason): void {
  for (const entry of Array.from(popoutsByWorktreeId.values())) {
    entry.closeReason = reason
    entry.state = 'closing'
    if (!entry.window.isDestroyed()) {
      entry.window.close()
    }
  }
}

export function _resetWorkspacePopoutsForTests(): void {
  for (const entry of popoutsByWorktreeId.values()) {
    if (!entry.window.isDestroyed()) {
      try {
        entry.window.close()
      } catch {
        // Ignore mock errors
      }
    }
  }
  popoutsByWorktreeId.clear()
  stateChangedListeners.clear()
  detachPopoutModuleListeners(moduleCallbacks)
}
