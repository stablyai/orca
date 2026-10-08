import { Menu, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { installDocPreviewGuestPolicy } from '../browser/doc-preview-guest-policy'
import { createPreviewWindow, revealPreviewWindow } from './document-preview-window-frame'
import { closeMarkdownPreviewWindows } from './markdown-preview-window'
export { openMarkdownPreviewWindow } from './markdown-preview-window'

const windows = new Map<string, BrowserWindow>()

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
  closeMarkdownPreviewWindows()
  for (const window of windows.values()) {
    if (!window.isDestroyed()) {
      window.close()
    }
  }
  windows.clear()
}
