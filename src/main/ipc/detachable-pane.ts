import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { DetachedTerminalTabSeed } from '../../shared/types'
import { detachablePaneWindowManager } from '../window/detachable-pane-window-manager'
import { getTrustedUIRendererWindow, isTrustedUIRenderer } from './ui'
import { registerDetachedPanePtys, unregisterDetachedPanePtys } from './pty'

// A detached pane's own popout renderer is never promoted to the single
// global trusted-UI-renderer, so it needs its own narrow grant — scoped to
// acting on its own paneId only — for the two calls it makes on itself
// (fetching its seed, asking to come back).
function isTrustedForPane(sender: WebContents, paneId: string): boolean {
  return (
    isTrustedUIRenderer(sender) || detachablePaneWindowManager.isPaneWindowSender(paneId, sender)
  )
}

function isDetachedTerminalTabShape(value: unknown, allowAdditionalTabs: boolean): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    (allowAdditionalTabs || !('additionalTabs' in candidate)) &&
    typeof candidate.worktreeId === 'string' &&
    typeof candidate.groupId === 'string' &&
    (candidate.ptyId === null || typeof candidate.ptyId === 'string') &&
    !!candidate.tab &&
    typeof candidate.tab === 'object' &&
    !!candidate.layout &&
    typeof candidate.layout === 'object' &&
    !!candidate.repo &&
    typeof candidate.repo === 'object' &&
    typeof (candidate.repo as Record<string, unknown>).id === 'string'
  )
}

function isDetachedTerminalTabSeed(value: unknown): value is DetachedTerminalTabSeed {
  if (!isDetachedTerminalTabShape(value, true)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    candidate.additionalTabs === undefined ||
    (Array.isArray(candidate.additionalTabs) &&
      candidate.additionalTabs.every((tab) => isDetachedTerminalTabShape(tab, false)))
  )
}

/**
 * Finish reintegration for both paths that can end it — an explicit
 * `pane:reintegrate` call (window still open) and a native close, which the
 * manager already parks (window gone). Grabs the seed before
 * `reintegratePane` clears it, then tells the main-window renderer to
 * reinsert the tab. One broadcast/one payload shape for both callers keeps
 * the main-window listener from needing to know which path fired.
 */
function finalizeReintegration(paneId: string): void {
  const trustedWindow = getTrustedUIRendererWindow()
  if (!trustedWindow) {
    // Why: no main window to hand the tab back to (e.g. it closed while the
    // pane stayed open on macOS) — leave the pane parked with its seed intact
    // so a later reintegrate attempt can still recover it, instead of
    // discarding the tab permanently via reintegratePane's teardown.
    console.warn('[detachable-pane] No trusted UI renderer to reintegrate pane', paneId)
    return
  }
  const seed = detachablePaneWindowManager.getPaneSeed(paneId)
  const ptyIds = seed
    ? [seed.ptyId, ...(seed.additionalTabs?.map((entry) => entry.ptyId) ?? [])].filter(
        (id): id is string => typeof id === 'string'
      )
    : []
  detachablePaneWindowManager.reintegratePane(paneId)
  if (ptyIds.length > 0) {
    unregisterDetachedPanePtys(ptyIds)
  }
  trustedWindow.webContents.send('pane:returned', { paneId, seed })
}

let unsubscribeParked: (() => void) | null = null

export function registerDetachablePaneHandlers(store: Store): void {
  ipcMain.removeHandler('pane:detach')
  ipcMain.removeHandler('pane:reintegrate')
  ipcMain.removeHandler('pane:removeTab')
  ipcMain.removeHandler('pane:getDetachedState')
  ipcMain.removeHandler('pane:getDetachedTabSeed')
  unsubscribeParked?.()
  unsubscribeParked = detachablePaneWindowManager.onPaneParked((paneId) => {
    finalizeReintegration(paneId)
  })

  ipcMain.handle('pane:detach', (event, args: unknown): void => {
    if (!isTrustedUIRenderer(event.sender)) {
      return
    }
    // Why: the renderer closes the tab when this call resolves, so a
    // resolved-but-not-detached call would lose the tab. The seed rides along
    // in the same call so a detached window can never exist without one.
    if (
      !args ||
      typeof args !== 'object' ||
      !('paneId' in args) ||
      typeof args.paneId !== 'string'
    ) {
      throw new Error('pane:detach requires a paneId')
    }
    if (!('seed' in args) || !isDetachedTerminalTabSeed(args.seed)) {
      throw new Error('pane:detach requires a valid seed')
    }
    const paneWindow = detachablePaneWindowManager.detachPane(args.paneId, store, args.seed)
    const seed = args.seed
    const ptyIds = [seed.ptyId, ...(seed.additionalTabs?.map((entry) => entry.ptyId) ?? [])].filter(
      (id): id is string => typeof id === 'string'
    )
    if (ptyIds.length > 0) {
      registerDetachedPanePtys(ptyIds, paneWindow.webContents)
    }
  })

  ipcMain.handle('pane:reintegrate', (event, args: unknown): void => {
    if (
      !args ||
      typeof args !== 'object' ||
      !('paneId' in args) ||
      typeof args.paneId !== 'string'
    ) {
      return
    }
    if (!isTrustedForPane(event.sender, args.paneId)) {
      return
    }
    finalizeReintegration(args.paneId)
  })

  ipcMain.handle('pane:getDetachedState', (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return null
    }
    if (
      !args ||
      typeof args !== 'object' ||
      !('paneId' in args) ||
      typeof args.paneId !== 'string'
    ) {
      return null
    }
    return detachablePaneWindowManager.getPaneState(args.paneId)
  })

  ipcMain.handle(
    'pane:getDetachedTabSeed',
    (event, args: unknown): DetachedTerminalTabSeed | null => {
      if (
        !args ||
        typeof args !== 'object' ||
        !('paneId' in args) ||
        typeof args.paneId !== 'string'
      ) {
        return null
      }
      if (!isTrustedForPane(event.sender, args.paneId)) {
        return null
      }
      return detachablePaneWindowManager.getPaneSeed(args.paneId)
    }
  )

  ipcMain.handle('pane:removeTab', (event, args: unknown) => {
    if (
      !args ||
      typeof args !== 'object' ||
      !('paneId' in args) ||
      typeof args.paneId !== 'string' ||
      !('tabId' in args) ||
      typeof args.tabId !== 'string'
    ) {
      return
    }
    if (!isTrustedForPane(event.sender, args.paneId)) {
      return
    }
    const result = detachablePaneWindowManager.removeTab(args.paneId, args.tabId)
    if (result.removedPtyId) {
      unregisterDetachedPanePtys([result.removedPtyId])
    }
  })
}
