import { randomUUID } from 'node:crypto'

import {
  BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS,
  BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS,
  type BrowserJavaScriptDialogType
} from '../../shared/browser-javascript-dialog'

type ElectronRunDialogInfo = {
  frame: Pick<Electron.WebFrameMain, 'origin' | 'url'>
  dialogType: BrowserJavaScriptDialogType
  messageText: string
  defaultPromptText: string
}

type ElectronRunDialogCallback = (success: boolean, userInput: string) => void
type ElectronRunDialogListener = (
  info: ElectronRunDialogInfo,
  callback: ElectronRunDialogCallback
) => void

type InternalWebContentsEvents = {
  listeners?: (eventName: string) => ((...args: never[]) => void)[]
  on: (eventName: string, listener: (...args: never[]) => void) => void
  off?: (eventName: string, listener: (...args: never[]) => void) => void
  removeListener?: (eventName: string, listener: (...args: never[]) => void) => void
}

export type BrowserJavaScriptDialogRequest = {
  dialogId: string
  dialogType: BrowserJavaScriptDialogType
  message: string
  defaultPromptText: string
  frameOrigin: string
  frameUrl: string
}

export type BrowserJavaScriptDialogController = {
  getPending: () => BrowserJavaScriptDialogRequest | null
  respond: (dialogId: string, accept: boolean, promptText?: string) => boolean
  dispose: () => void
}

function boundDialogText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  const codePoints = [...value]
  if (codePoints.length <= maxChars) {
    return value
  }
  return `${codePoints.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

function normalizeDialogType(value: unknown): BrowserJavaScriptDialogType {
  return value === 'confirm' || value === 'prompt' ? value : 'alert'
}

// Why: Electron exposes no public JavaScript-dialog interception API. Its pinned
// WebContents implementation routes alert/confirm/prompt through this internal
// event, so replacing only that listener avoids a BrowserWindow-wide native sheet
// while preserving Chromium's blocking callback and CDP handleJavaScriptDialog.
export function installBrowserJavaScriptDialogController(
  guest: Electron.WebContents,
  handlers: {
    onOpened: (dialog: BrowserJavaScriptDialogRequest) => void
    onClosed: (dialog: BrowserJavaScriptDialogRequest) => void
  }
): BrowserJavaScriptDialogController {
  const events = guest as unknown as InternalWebContentsEvents
  const removeListener = (eventName: string, listener: (...args: never[]) => void): void => {
    if (typeof events.removeListener === 'function') {
      events.removeListener(eventName, listener)
    } else {
      events.off?.(eventName, listener)
    }
  }
  const originalRunDialogListeners = events.listeners?.('-run-dialog') ?? []
  for (const listener of originalRunDialogListeners) {
    removeListener('-run-dialog', listener)
  }

  let disposed = false
  let pending: {
    request: BrowserJavaScriptDialogRequest
    callback: ElectronRunDialogCallback
  } | null = null

  const closePending = (invokeCallback: boolean): void => {
    const current = pending
    if (!current) {
      return
    }
    pending = null
    try {
      handlers.onClosed(current.request)
    } catch {
      // Renderer notification is best-effort; teardown must still resolve the blocking callback.
    }
    if (invokeCallback) {
      try {
        current.callback(false, '')
      } catch {
        // Chromium may already have invalidated the callback during teardown.
      }
    }
  }

  const handleRunDialog: ElectronRunDialogListener = (info, callback) => {
    if (disposed) {
      callback(false, '')
      return
    }
    closePending(true)
    const request: BrowserJavaScriptDialogRequest = {
      dialogId: randomUUID(),
      dialogType: normalizeDialogType(info?.dialogType),
      message: boundDialogText(info?.messageText, BROWSER_JAVASCRIPT_DIALOG_MESSAGE_MAX_CHARS),
      defaultPromptText: boundDialogText(
        info?.defaultPromptText,
        BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS
      ),
      frameOrigin: typeof info?.frame?.origin === 'string' ? info.frame.origin : '',
      frameUrl: typeof info?.frame?.url === 'string' ? info.frame.url : ''
    }
    pending = { request, callback }
    try {
      handlers.onOpened(request)
    } catch {
      closePending(true)
    }
  }

  const handleCancelDialogs = (): void => {
    // CDP/agent-browser resolves the same Chromium dialog out of band. Clear the
    // scoped UI without invoking the callback a second time.
    closePending(false)
  }
  const handleDebuggerMessage = (_event: unknown, method: string): void => {
    if (method === 'Page.javascriptDialogClosed') {
      closePending(false)
    }
  }

  events.on('-run-dialog', handleRunDialog as (...args: never[]) => void)
  events.on('-cancel-dialogs', handleCancelDialogs as (...args: never[]) => void)
  if (typeof guest.debugger?.on === 'function') {
    guest.debugger.on('message', handleDebuggerMessage as never)
  }

  return {
    getPending: () => pending?.request ?? null,
    respond: (dialogId, accept, promptText) => {
      const current = pending
      if (!current || current.request.dialogId !== dialogId) {
        return false
      }
      pending = null
      const responseText =
        accept && current.request.dialogType === 'prompt'
          ? boundDialogText(promptText, BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS)
          : ''
      try {
        handlers.onClosed(current.request)
      } catch {
        // Renderer notification is best-effort; the blocking callback must still resolve.
      }
      try {
        current.callback(accept, responseText)
        return true
      } catch {
        return false
      }
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      removeListener('-run-dialog', handleRunDialog as (...args: never[]) => void)
      removeListener('-cancel-dialogs', handleCancelDialogs as (...args: never[]) => void)
      if (typeof guest.debugger?.off === 'function') {
        guest.debugger.off('message', handleDebuggerMessage as never)
      }
      closePending(true)
      if (!guest.isDestroyed()) {
        for (const listener of originalRunDialogListeners) {
          events.on('-run-dialog', listener)
        }
      }
    }
  }
}
