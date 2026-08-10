import { BrowserWindow, dialog, nativeTheme, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { EditorPopoutOpenRequest } from '../../shared/editor-popout'
import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import { translateMain } from '../i18n/main-i18n'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

const EDITOR_POPOUT_PARTITION = 'orca-editor-popout'
const MIN_WIDTH = 560
const MIN_HEIGHT = 420

type EditorPopoutEntry = {
  window: BrowserWindow
  request: EditorPopoutOpenRequest
  dirty: boolean
  allowClose: boolean
  closeDialogOpen: boolean
  closeCheckPending: boolean
}

const entriesByKey = new Map<string, EditorPopoutEntry>()
const entriesByWebContentsId = new Map<number, EditorPopoutEntry>()

function getRequestKey(request: EditorPopoutOpenRequest): string {
  const owner =
    request.document.runtimeEnvironmentId ?? request.document.externalSshTargetId ?? 'local'
  return `${owner}\0${request.document.worktreeId}\0${request.document.filePath}`
}

function loadEditorPopout(window: BrowserWindow): void {
  const search = 'surface=editor'
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html?${search}`)
    return
  }
  void window.loadFile(join(__dirname, '../renderer/popout.html'), { search })
}

async function confirmDirtyClose(entry: EditorPopoutEntry): Promise<void> {
  const name = getRuntimePathBasename(entry.request.document.filePath)
  const result = await dialog.showMessageBox(entry.window, {
    type: 'warning',
    title: translateMain('editorPopout.unsavedChanges', 'Unsaved Changes'),
    message: translateMain('editorPopout.closeConfirmTitle', `Save changes to ${name}?`, { name }),
    detail: translateMain(
      'editorPopout.closeConfirmMessage',
      'Your changes will be lost if you close this window without saving.'
    ),
    buttons: [
      translateMain('editorPopout.save', 'Save'),
      translateMain('editorPopout.cancel', 'Cancel'),
      translateMain('editorPopout.discard', "Don't Save")
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (entry.window.isDestroyed()) {
    return
  }
  if (result.response === 0) {
    entry.window.webContents.send('editorPopout:saveAndClose')
    return
  }
  entry.closeDialogOpen = false
  if (result.response === 1) {
    return
  }
  entry.allowClose = true
  entry.window.close()
}

export function createOrFocusEditorPopout(request: EditorPopoutOpenRequest): BrowserWindow {
  const key = getRequestKey(request)
  const existing = entriesByKey.get(key)
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) {
      existing.window.restore()
    }
    existing.window.focus()
    return existing.window
  }

  const window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: `${getRuntimePathBasename(request.document.filePath)} - Orca`,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/editor-popout.js'),
      sandbox: true,
      partition: EDITOR_POPOUT_PARTITION,
      webviewTag: false
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)

  const entry: EditorPopoutEntry = {
    window,
    request,
    dirty: request.content !== request.savedContent,
    allowClose: false,
    closeDialogOpen: false,
    closeCheckPending: false
  }
  const webContentsId = window.webContents.id
  entriesByKey.set(key, entry)
  entriesByWebContentsId.set(webContentsId, entry)

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
  window.on('close', (event) => {
    if (entry.allowClose) {
      return
    }
    event.preventDefault()
    if (!entry.closeDialogOpen && !entry.closeCheckPending) {
      entry.closeCheckPending = true
      window.webContents.send('editorPopout:requestCloseState')
    }
  })
  window.on('closed', () => {
    entriesByKey.delete(key)
    entriesByWebContentsId.delete(webContentsId)
  })

  loadEditorPopout(window)
  return window
}

export function isEditorPopoutRenderer(sender: WebContents): boolean {
  return !sender.isDestroyed() && entriesByWebContentsId.has(sender.id)
}

export function getEditorPopoutRequest(sender: WebContents): EditorPopoutOpenRequest | null {
  return entriesByWebContentsId.get(sender.id)?.request ?? null
}

export function setEditorPopoutDirty(sender: WebContents, dirty: boolean): void {
  const entry = entriesByWebContentsId.get(sender.id)
  if (entry) {
    entry.dirty = dirty
  }
}

export function reportEditorPopoutCloseState(sender: WebContents, dirty: boolean): void {
  const entry = entriesByWebContentsId.get(sender.id)
  if (!entry || !entry.closeCheckPending) {
    return
  }
  entry.closeCheckPending = false
  entry.dirty = dirty
  if (!dirty) {
    entry.allowClose = true
    entry.window.close()
    return
  }
  entry.closeDialogOpen = true
  void confirmDirtyClose(entry)
}

export function completeEditorPopoutSaveAndClose(sender: WebContents, saved: boolean): void {
  const entry = entriesByWebContentsId.get(sender.id)
  if (!entry) {
    return
  }
  entry.closeDialogOpen = false
  if (!saved) {
    return
  }
  entry.dirty = false
  entry.allowClose = true
  entry.window.close()
}

export function closeAllEditorPopouts(): void {
  for (const entry of entriesByKey.values()) {
    if (!entry.window.isDestroyed()) {
      entry.window.close()
    }
  }
}
