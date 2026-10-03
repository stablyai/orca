import { BrowserWindow, Menu, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { MarkdownPreviewWindowRequest } from '../../shared/document-preview-window'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { getDocPreviewSession } from '../browser/doc-preview-protocol'
import { installDocPreviewGuestPolicy } from '../browser/doc-preview-guest-policy'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

const windows = new Map<string, BrowserWindow>()
let markdownSessionConfigured = false

function revealPreviewWindow(window: BrowserWindow): void {
  if (!isBackgroundLaunch() && window.isMinimized()) {
    window.restore()
  }
  showWindowWithoutStealingFocus(window)
}

function createPreviewWindow(title: string, htmlDocument: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 360,
    minHeight: 240,
    title,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      javascript: htmlDocument,
      ...(htmlDocument
        ? { session: getDocPreviewSession() }
        : { partition: 'orca-markdown-preview' })
    }
  })
  window.once('ready-to-show', () => showWindowWithoutStealingFocus(window))
  return window
}

export async function openMarkdownPreviewWindow(
  request: MarkdownPreviewWindowRequest
): Promise<void> {
  const key = `markdown:${request.fileId}`
  const existing = windows.get(key)
  const window =
    existing && !existing.isDestroyed() ? existing : createPreviewWindow(request.title, false)
  if (window !== existing) {
    installPrivilegedWindowNavigationPolicy(window.webContents)
    if (!markdownSessionConfigured) {
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.webContents.session.on('will-download', (event) => event.preventDefault())
      markdownSessionConfigured = true
    }
    windows.set(key, window)
    window.once('closed', () => {
      if (windows.get(key) === window) {
        windows.delete(key)
      }
    })
  }
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(request.html).toString('base64')}`
    )
    revealPreviewWindow(window)
  } catch (error) {
    window.close()
    throw error
  }
}

export async function openHtmlPreviewWindow(grantId: string, host: WebContents): Promise<void> {
  const source = getDocPreviewGrant(grantId)
  if (!source) {
    throw new Error('Document preview is no longer available. Reload it and try again.')
  }
  const key = `html:${source.browserPageId}`
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    revealPreviewWindow(existing)
    return
  }
  // Why: closing the original tab must not revoke the independent window's file access.
  const grant = mintDocPreviewGrant({ ...source, browserPageId: `document-window:${randomUUID()}` })
  grant.authorizedRoots = [...source.authorizedRoots]
  const window = createPreviewWindow(source.entryRelativePath, true)
  windows.set(key, window)
  const disposePolicy = installDocPreviewGuestPolicy(window.webContents, host)
  window.setMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu', submenu: [{ role: 'close' }] },
      {
        role: 'viewMenu',
        submenu: [
          { role: 'reload' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
  window.once('closed', () => {
    if (windows.get(key) === window) {
      windows.delete(key)
    }
    disposePolicy()
    revokeDocPreviewGrant(grant.id)
  })
  try {
    await window.loadURL(buildDocPreviewUrl(grant.id, grant.entryRelativePath))
  } catch (error) {
    window.close()
    throw error
  }
}

export function closeDocumentPreviewWindows(): void {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) {
      window.close()
    }
  }
  windows.clear()
}
