import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import * as path from 'node:path'
import { is } from '@electron-toolkit/utils'
import type {
  DetachedTerminalOpenSnapshot,
  DetachedTerminalSnapshot
} from '../../shared/detached-terminal-window'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getAppIconPath } from '../app-icon'
import { detachedWindowRegistry, type DetachedWindowKey } from './detached-window-registry'
import { trustedRendererRegistry } from './trusted-renderer-registry'
import { paneOwnershipRegistry } from './pane-ownership-registry'
import {
  normalizeId,
  senderCanDetachSnapshot,
  validateDetachedTerminalSnapshot
} from './detached-terminal-snapshot-validation'

type OpenDetachedTerminalWindowArgs = {
  worktreeId: string
  tabId: string
  snapshot: DetachedTerminalOpenSnapshot
}

type DetachedTerminalOpenResult =
  | { ok: true }
  | { ok: false; error: 'invalid_payload' | 'detached_terminal_tab_unavailable' }

function loadDetachedTerminalWindow(window: BrowserWindow, key: DetachedWindowKey): void {
  const query = {
    mode: 'detached-terminal',
    worktreeId: key.worktreeId,
    tabId: key.tabId
  }
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value)
    }
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
}

export function openDetachedTerminalWindow({
  worktreeId,
  tabId,
  snapshot
}: OpenDetachedTerminalWindowArgs): BrowserWindow {
  const key = { worktreeId, tabId }
  const existing = detachedWindowRegistry.getDetachedTerminalWindow(key)
  if (existing) {
    detachedWindowRegistry.focusDetachedTerminalWindow(key)
    return existing
  }

  const validated = validateDetachedTerminalSnapshot(worktreeId, tabId, snapshot)
  if (!validated) {
    throw new Error('detached_terminal_tab_unavailable')
  }

  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: snapshot.terminalTab.title || 'Terminal',
    show: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : undefined,
    ...(process.platform === 'linux' ? { frame: false } : {}),
    icon: getAppIconPath(snapshot.settings?.appIcon),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: false
    }
  })

  const webContentsId = window.webContents.id
  trustedRendererRegistry.grantMany(webContentsId, ['ui', 'clipboard', 'pty'])
  detachedWindowRegistry.registerDetachedTerminalWindow(key, window, validated.snapshot)

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  loadDetachedTerminalWindow(window, key)
  return window
}

export function registerDetachedTerminalHandlers(): void {
  ipcMain.removeHandler('detachedTerminal:openWindow')
  ipcMain.removeHandler('detachedTerminal:getSnapshot')
  ipcMain.removeHandler('detachedTerminal:closeWindow')
  ipcMain.removeHandler('detachedTerminal:rendererPtyReady')

  ipcMain.handle(
    'detachedTerminal:openWindow',
    (event, args: OpenDetachedTerminalWindowArgs): DetachedTerminalOpenResult => {
      const worktreeId = normalizeId(args?.worktreeId)
      const tabId = normalizeId(args?.tabId)
      if (!worktreeId || !tabId || !args?.snapshot) {
        return { ok: false, error: 'invalid_payload' }
      }
      const key = { worktreeId, tabId }
      const existing = detachedWindowRegistry.getDetachedTerminalWindow(key)
      if (existing) {
        const senderId = event.sender.id
        if (
          existing.webContents.id === senderId ||
          paneOwnershipRegistry.isPrimaryAppWebContentsId(senderId)
        ) {
          detachedWindowRegistry.focusDetachedTerminalWindow(key)
          return { ok: true }
        }
        return { ok: false, error: 'detached_terminal_tab_unavailable' }
      }
      const validated = validateDetachedTerminalSnapshot(worktreeId, tabId, args.snapshot)
      if (!validated || !senderCanDetachSnapshot(event.sender, validated)) {
        return { ok: false, error: 'detached_terminal_tab_unavailable' }
      }
      try {
        openDetachedTerminalWindow({ worktreeId, tabId, snapshot: args.snapshot })
        return { ok: true }
      } catch (error) {
        if (error instanceof Error && error.message === 'detached_terminal_tab_unavailable') {
          return { ok: false, error: 'detached_terminal_tab_unavailable' }
        }
        throw error
      }
    }
  )

  ipcMain.handle(
    'detachedTerminal:getSnapshot',
    (event, args: { worktreeId?: unknown; tabId?: unknown }): DetachedTerminalSnapshot => {
      const worktreeId = normalizeId(args?.worktreeId)
      const tabId = normalizeId(args?.tabId)
      if (!worktreeId || !tabId) {
        throw new Error('invalid_payload')
      }
      const key = { worktreeId, tabId }
      const window = detachedWindowRegistry.getDetachedTerminalWindow(key)
      const snapshot = detachedWindowRegistry.getDetachedTerminalSnapshot(key)
      if (!window || !snapshot || window.webContents.id !== event.sender.id) {
        throw new Error('detached_terminal_tab_unavailable')
      }
      return snapshot
    }
  )

  ipcMain.handle(
    'detachedTerminal:closeWindow',
    (event, args: { worktreeId?: unknown; tabId?: unknown }): { ok: true } => {
      const worktreeId = normalizeId(args?.worktreeId)
      const tabId = normalizeId(args?.tabId)
      if (worktreeId && tabId) {
        const key = { worktreeId, tabId }
        const window = detachedWindowRegistry.getDetachedTerminalWindow(key)
        const senderId = event.sender.id
        if (
          window &&
          (window.webContents.id === senderId ||
            paneOwnershipRegistry.isPrimaryAppWebContentsId(senderId))
        ) {
          detachedWindowRegistry.closeDetachedTerminalWindow(key)
        }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    'detachedTerminal:rendererPtyReady',
    (event, args: { worktreeId?: unknown; tabId?: unknown; ptyId?: unknown }): { ok: true } => {
      const worktreeId = normalizeId(args?.worktreeId)
      const tabId = normalizeId(args?.tabId)
      const ptyId = normalizeId(args?.ptyId)
      if (!worktreeId || !tabId || !ptyId) {
        return { ok: true }
      }
      const key = { worktreeId, tabId }
      const window = detachedWindowRegistry.getDetachedTerminalWindow(key)
      const snapshot = detachedWindowRegistry.getDetachedTerminalSnapshot(key)
      if (!window || !snapshot || window.webContents.id !== event.sender.id) {
        return { ok: true }
      }
      if (!snapshot.ptyIds.includes(ptyId)) {
        return { ok: true }
      }
      const leafEntry = Object.entries(snapshot.terminalLayout.ptyIdsByLeafId ?? {}).find(
        ([, candidatePtyId]) => candidatePtyId === ptyId
      )
      const paneKey = leafEntry ? makePaneKey(tabId, leafEntry[0]) : null
      paneOwnershipRegistry.registerPaneOwner({
        webContentsId: event.sender.id,
        ptyId,
        paneKey,
        worktreeId,
        tabId
      })
      return { ok: true }
    }
  )
}
