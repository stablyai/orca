import { BrowserWindow, ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { activateExtensionAction } from '../browser/extensions/extension-action'
import {
  showExtensionActionMenu,
  openExtensionOptions
} from '../browser/extensions/extension-action-menu'
import {
  listExtensionActions,
  setExtensionActionsChangedListener
} from '../browser/extensions/extension-action-state'
import { runBrowserExtensionMenuItem } from '../browser/extensions/extension-context-menus'
import { listInstalledBrowserExtensions } from '../browser/extensions/extension-installed-list'
import {
  browserExtensionSessions,
  removeBrowserExtension,
  setBrowserExtensionEnabled,
  setInstalledBrowserExtensionsChangedListener
} from '../browser/extensions/extension-sessions'
import { extensionToolbarRenderers } from '../browser/extensions/extension-tab-registry'
import type {
  BrowserExtensionAction,
  BrowserExtensionActionAnchor,
  BrowserInstalledExtension
} from '../../shared/browser-guest-events'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const EXTENSION_ID = /^[a-p]{32}$/

function anchorOf(value: unknown): BrowserExtensionActionAnchor | null {
  const read = (key: string): number => Number(Reflect.get(Object(value), key))
  const anchor = { x: read('x'), y: read('y'), width: read('width'), height: read('height') }
  return Object.values(anchor).every(Number.isFinite) ? anchor : null
}

/** The page's guest when a trusted renderer asks about one of its own pages. */
function guestFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, pageId: unknown) {
  if (!isTrustedBrowserRenderer(event.sender) || typeof pageId !== 'string') {
    return null
  }
  return browserManager.getAuthorizedBrowsingGuest(pageId, event.sender.id)
}

function extensionIdOf(value: unknown): string | null {
  return typeof value === 'string' && EXTENSION_ID.test(value) ? value : null
}

function broadcast(channel: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isTrustedBrowserRenderer(window.webContents)) {
      window.webContents.send(channel)
    }
  }
}

export function registerBrowserExtensionHandlers(): void {
  ipcMain.removeHandler('browser:extensionActions')
  ipcMain.removeHandler('browser:installedExtensions')
  ipcMain.removeHandler('browser:setExtensionEnabled')
  ipcMain.removeHandler('browser:removeExtension')
  ipcMain.removeHandler('browser:openExtensionOptions')
  ipcMain.removeAllListeners?.('browser:activateExtensionAction')
  ipcMain.removeAllListeners?.('browser:showExtensionActionMenu')
  ipcMain.removeAllListeners?.('browser:runExtensionMenuItem')

  setExtensionActionsChangedListener((session) => {
    for (const renderer of extensionToolbarRenderers(session)) {
      renderer.send('browser:extension-actions-changed')
    }
  })
  setInstalledBrowserExtensionsChangedListener(() => {
    broadcast('browser:extension-actions-changed')
    broadcast('browser:installed-extensions-changed')
  })

  ipcMain.handle(
    'browser:extensionActions',
    (event, args: { browserPageId?: unknown }): BrowserExtensionAction[] => {
      const guest = guestFor(event, args?.browserPageId)
      return guest ? listExtensionActions(guest) : []
    }
  )

  ipcMain.on?.(
    'browser:activateExtensionAction',
    (event, args: { browserPageId?: unknown; extensionId?: unknown; anchor?: unknown }) => {
      const guest = guestFor(event, args?.browserPageId)
      const extensionId = extensionIdOf(args?.extensionId)
      const anchor = anchorOf(args?.anchor)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (guest && extensionId && anchor && window) {
        activateExtensionAction(guest, extensionId, anchor, window)
      }
    }
  )

  ipcMain.on?.(
    'browser:showExtensionActionMenu',
    (event, args: { browserPageId?: unknown; extensionId?: unknown }) => {
      const guest = guestFor(event, args?.browserPageId)
      const extensionId = extensionIdOf(args?.extensionId)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (guest && extensionId && window) {
        showExtensionActionMenu(guest, extensionId, window)
      }
    }
  )

  ipcMain.on?.(
    'browser:runExtensionMenuItem',
    (event, args: { browserPageId?: unknown; index?: unknown }) => {
      const guest = guestFor(event, args?.browserPageId)
      if (guest && Number.isInteger(args.index)) {
        runBrowserExtensionMenuItem(
          guest,
          Number(args.index),
          BrowserWindow.fromWebContents(event.sender)
        )
      }
    }
  )

  ipcMain.handle(
    'browser:installedExtensions',
    (event): Promise<BrowserInstalledExtension[]> | [] =>
      isTrustedBrowserRenderer(event.sender) ? listInstalledBrowserExtensions() : []
  )

  ipcMain.handle(
    'browser:setExtensionEnabled',
    async (event, args: { extensionId?: unknown; enabled?: unknown }) => {
      const extensionId = extensionIdOf(args?.extensionId)
      if (
        isTrustedBrowserRenderer(event.sender) &&
        extensionId &&
        typeof args.enabled === 'boolean'
      ) {
        await setBrowserExtensionEnabled(extensionId, args.enabled)
      }
    }
  )

  ipcMain.handle('browser:removeExtension', async (event, args: { extensionId?: unknown }) => {
    const extensionId = extensionIdOf(args?.extensionId)
    if (isTrustedBrowserRenderer(event.sender) && extensionId) {
      await removeBrowserExtension(extensionId)
    }
  })

  ipcMain.handle('browser:openExtensionOptions', (event, args: { extensionId?: unknown }) => {
    const extensionId = extensionIdOf(args?.extensionId)
    const [session] = browserExtensionSessions()
    if (isTrustedBrowserRenderer(event.sender) && extensionId && session) {
      openExtensionOptions(session, extensionId)
    }
  })
}
