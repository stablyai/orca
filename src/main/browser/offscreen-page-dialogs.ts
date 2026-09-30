import { dialog } from 'electron'
import type {
  BaseWindow,
  MessageBoxOptions,
  OpenDialogOptions,
  WebContents,
  WebPreferences
} from 'electron'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'
import { fileDialogFiltersForAccept } from './offscreen-page-file-accept'

type RunDialogInfo = {
  frame: { origin: string; url: string }
  dialogType: 'alert' | 'confirm' | 'prompt'
  messageText: string
}
type DialogClosed = (success: boolean, userInput: string) => void

/** Setup the file chooser needs on every debugger attach. */
export const OFFSCREEN_PAGE_DIALOG_SETUP = [
  ['Page.enable'],
  ['Page.setInterceptFileChooserDialog', { enabled: true }]
] as const

/**
 * Shows an offscreen page's JavaScript dialogs and file choosers as sheets on the Orca window,
 * where a <webview>'s appear. Electron would otherwise parent them on the page's hidden window,
 * or, for offscreen pages, float an app-modal alert over every app.
 */
export function routeOffscreenPageDialogs(args: {
  contents: WebContents
  session: OffscreenPageCdpSession
  webPreferences: WebPreferences
  parentWindow: () => BaseWindow | null
}): () => void {
  const { contents, session, parentWindow } = args
  const stopJavaScriptDialogs = routeJavaScriptDialogs(contents, args.webPreferences, parentWindow)
  const stopFileChoosers = session.onMessage((method, params, sessionId) => {
    if (method === 'Page.fileChooserOpened' && typeof params.backendNodeId === 'number') {
      void chooseFiles(frameSession(session, sessionId), params.backendNodeId, parentWindow())
    }
  })
  return () => {
    stopJavaScriptDialogs()
    stopFileChoosers()
  }
}

/**
 * Takes over Electron's own '-run-dialog' handler, keeping its rules (origin suppression, the
 * safeDialogs checkbox, no prompt()) and changing only the parent window.
 */
function routeJavaScriptDialogs(
  contents: WebContents,
  prefs: WebPreferences,
  parentWindow: () => BaseWindow | null
): () => void {
  const emitter: NodeJS.EventEmitter = contents
  const originCounts = new Map<string, number>()
  const open = new Set<AbortController>()
  const onRunDialog = async (info: RunDialogInfo, callback: DialogClosed): Promise<void> => {
    const origin = info.frame.origin === 'file://' ? info.frame.url : info.frame.origin
    if ((originCounts.get(origin) ?? 0) < 0 || prefs.disableDialogs) {
      return callback(false, '')
    }
    if (info.dialogType === 'prompt') {
      return callback(false, '')
    }
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1)
    const abort = new AbortController()
    const options: MessageBoxOptions = {
      message: info.messageText,
      checkboxLabel:
        (originCounts.get(origin) ?? 0) > 1 && prefs.safeDialogs
          ? prefs.safeDialogsMessage || 'Prevent this app from creating additional dialogs'
          : '',
      signal: abort.signal,
      ...(info.dialogType === 'confirm'
        ? { buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 }
        : { buttons: ['OK'], defaultId: -1, cancelId: 0 })
    }
    open.add(abort)
    try {
      const parent = parentWindow()
      const result = await (parent
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options))
      if (abort.signal.aborted || contents.isDestroyed()) {
        return
      }
      if (result.checkboxChecked) {
        originCounts.set(origin, -1)
      }
      callback(result.response === 0, '')
    } finally {
      open.delete(abort)
    }
  }
  const onCancelDialogs = (): void => {
    for (const abort of open) {
      abort.abort()
    }
    open.clear()
  }
  emitter.removeAllListeners('-run-dialog')
  emitter.on('-run-dialog', onRunDialog)
  emitter.on('-cancel-dialogs', onCancelDialogs)
  return () => {
    onCancelDialogs()
    emitter.off('-run-dialog', onRunDialog)
    emitter.off('-cancel-dialogs', onCancelDialogs)
  }
}

/** The page session narrowed to one frame target, where that frame's node ids mean something. */
function frameSession(
  session: OffscreenPageCdpSession,
  sessionId: string | undefined
): Pick<OffscreenPageCdpSession, 'send'> {
  return { send: (method, params) => session.send(method, params, sessionId) }
}

async function chooseFiles(
  session: Pick<OffscreenPageCdpSession, 'send'>,
  backendNodeId: number,
  parent: BaseWindow | null
): Promise<void> {
  const described = await session.send('DOM.describeNode', { backendNodeId }).catch(() => null)
  const attributes = readAttributes(described)
  const folder = attributes.has('webkitdirectory')
  const options: OpenDialogOptions = {
    properties: folder
      ? ['openDirectory']
      : attributes.has('multiple')
        ? ['openFile', 'multiSelections']
        : ['openFile'],
    filters: folder ? [] : fileDialogFiltersForAccept(attributes.get('accept') ?? '')
  }
  const result = await (parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options))
  if (result.canceled || result.filePaths.length === 0) {
    // Why: the page still hears about the dismissal, as it does from Chromium's own chooser.
    await session
      .send('Runtime.callFunctionOn', {
        objectId: await resolveObjectId(session, backendNodeId),
        functionDeclaration:
          'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })) }'
      })
      .catch(() => {})
    return
  }
  // Why pass a folder as-is: Blink enumerates a webkitdirectory input's folder itself.
  await session
    .send('DOM.setFileInputFiles', { files: result.filePaths, backendNodeId })
    .catch(() => {})
}

async function resolveObjectId(
  session: Pick<OffscreenPageCdpSession, 'send'>,
  backendNodeId: number
): Promise<string | undefined> {
  const resolved = await session.send('DOM.resolveNode', { backendNodeId }).catch(() => null)
  const object = isRecord(resolved) && isRecord(resolved.object) ? resolved.object : null
  return typeof object?.objectId === 'string' ? object.objectId : undefined
}

function readAttributes(described: unknown): Map<string, string> {
  const node = isRecord(described) && isRecord(described.node) ? described.node : null
  const flat = Array.isArray(node?.attributes) ? node.attributes : []
  const attributes = new Map<string, string>()
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [name, value] = [flat[i], flat[i + 1]]
    if (typeof name === 'string' && typeof value === 'string') {
      attributes.set(name.toLowerCase(), value)
    }
  }
  return attributes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
