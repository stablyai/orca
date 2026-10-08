import type { BrowserWindow, WebContents } from 'electron'
import type {
  MarkdownPreviewWindowRequest,
  MarkdownPreviewWindowSource
} from '../../shared/document-preview-window'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  revokeDocPreviewGrant
} from '../browser/doc-preview-grant-registry'
import { readDocPreviewFile } from '../browser/doc-preview-file-reader'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { createPreviewWindow, revealPreviewWindow } from './document-preview-window-frame'

type Preview = { window: BrowserWindow; grantId: string | null }
const previews = new Map<string, Preview>()
let sessionConfigured = false
const MARKDOWN_WINDOW_UPDATE_WORLD_ID = 1209

export async function openMarkdownPreviewWindow(
  request: MarkdownPreviewWindowRequest,
  host?: WebContents
): Promise<void> {
  const source = request.sourceGrantId ? getDocPreviewGrant(request.sourceGrantId) : null
  if (request.sourceGrantId && !source) {
    throw new Error('Markdown source is no longer available.')
  }
  let preview = previews.get(request.fileId)
  if (!preview || preview.window.isDestroyed()) {
    const window = createPreviewWindow(request.title, false)
    installPrivilegedWindowNavigationPolicy(window.webContents)
    if (!sessionConfigured) {
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.webContents.session.on('will-download', (event) => event.preventDefault())
      sessionConfigured = true
    }
    preview = { window, grantId: null }
    previews.set(request.fileId, preview)
    const record = preview
    window.once('closed', () => {
      if (record.grantId) {
        revokeDocPreviewGrant(record.grantId)
      }
      if (previews.get(request.fileId) === record) {
        previews.delete(request.fileId)
      }
      if (host && !host.isDestroyed()) {
        host.send('docPreview:markdownWindowClosed', request.fileId)
      }
    })
  }
  if (source) {
    const grant = mintDocPreviewGrant({
      ...source,
      browserPageId: `markdown-window:${request.fileId}`
    })
    grant.authorizedRoots = [...source.authorizedRoots]
    if (preview.grantId) {
      revokeDocPreviewGrant(preview.grantId)
    }
    preview.grantId = grant.id
  }
  try {
    await preview.window.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(request.html).toString('base64')}`
    )
    revealPreviewWindow(preview.window)
  } catch (error) {
    preview.window.close()
    throw error
  }
}

export async function readMarkdownPreviewWindowSource(
  fileId: string
): Promise<MarkdownPreviewWindowSource> {
  const preview = previews.get(fileId)
  if (!preview || preview.window.isDestroyed()) {
    return { open: false, content: null, error: null }
  }
  const grant = preview.grantId ? getDocPreviewGrant(preview.grantId) : null
  if (!grant) {
    return { open: true, content: null, error: 'Markdown source is unavailable.' }
  }
  const result = await readDocPreviewFile(grant, grant.entryRelativePath)
  return result.ok
    ? { open: true, content: result.bytes.toString('utf8'), error: null }
    : { open: true, content: null, error: result.message }
}

export async function updateMarkdownPreviewWindow(
  request: MarkdownPreviewWindowRequest
): Promise<boolean> {
  const preview = previews.get(request.fileId)
  if (!preview || preview.window.isDestroyed()) {
    return false
  }
  // Why: replacing the body avoids a navigation and keeps the reader's position; document scripts remain disabled.
  await preview.window.webContents.executeJavaScriptInIsolatedWorld(
    MARKDOWN_WINDOW_UPDATE_WORLD_ID,
    [
      {
        code: `(() => {
    const scrollX = window.scrollX, scrollY = window.scrollY;
    const next = new DOMParser().parseFromString(${JSON.stringify(request.html)}, 'text/html');
    const error = ${JSON.stringify(request.refreshError ?? null)};
    if (error) {
      const notice = document.createElement('p');
      notice.setAttribute('role', 'status');
      notice.textContent = error;
      next.body.prepend(notice);
    }
    document.body.replaceChildren(...Array.from(next.body.childNodes));
    window.scrollTo(scrollX, scrollY);
  })()`
      }
    ]
  )
  return true
}

export function closeMarkdownPreviewWindows(): void {
  for (const preview of previews.values()) {
    if (!preview.window.isDestroyed()) {
      preview.window.close()
    }
  }
  previews.clear()
}
