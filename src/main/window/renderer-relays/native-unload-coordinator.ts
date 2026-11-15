import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from '../../../shared/quit-teardown-deadline'

type BeforeReload = (options: { webContentsId: number; ignoreCache: boolean }) => void
/** saved: durable; failed: renderer refused (cancel); unreachable: reload as before; superseded: document already gone. */
type PrepareOutcome = 'saved' | 'failed' | 'unreachable' | 'superseded'
type NativeUnload = {
  prepare(): Promise<PrepareOutcome>
  /** Tells the last prepared document that main will not reload it after all. */
  cancelPrepared(): void
  beforeReload?: BeforeReload
}

// Quit's frozen-renderer bound plus the checkpoint flush deadline, so a live renderer still gets main's durable verdict.
const NATIVE_UNLOAD_PREPARE_DEADLINE_MS =
  QUIT_RENDERER_ACK_TIMEOUT_MS + WILL_QUIT_TEARDOWN_DEADLINE_MS

type ReloadOptions = { ignoreCache: boolean; replacedByClose?: boolean }
const reloads = new WeakMap<WebContents, { options: ReloadOptions; promise: Promise<void> }>()
const coordinators = new WeakMap<WebContents, NativeUnload>()
// Value is whether the close is part of a quit.
const closesInFlight = new WeakMap<WebContents, boolean>()

/** Main marks a close request until the renderer confirms or cancels it, or dies. */
export function setWindowCloseInFlight(
  contents: WebContents,
  close: { quitting: boolean } | null
): void {
  if (close) {
    closesInFlight.set(contents, close.quitting)
  } else {
    closesInFlight.delete(contents)
  }
}

export function isWindowCloseInFlight(contents: WebContents): boolean {
  return closesInFlight.has(contents)
}

function cancelPreparedUnload(frame: Electron.WebFrameMain, requestId: string): void {
  try {
    // Restores the renderer's ordinary unload guards, which its reload preparation suspended.
    frame.send('app:native-unload-canceled', requestId)
  } catch {
    // Frame already gone; nothing left to restore.
  }
}

/** Native reloads join the document's durable checkpoint, like the renderer's own restart/reload. */
export function installNativeUnloadCoordinator(
  window: BrowserWindow,
  beforeReload?: BeforeReload
): void {
  const contents = window.webContents
  let pending: Promise<PrepareOutcome> | undefined
  let settlePending: ((outcome: PrepareOutcome) => void) | undefined
  let lastRequest: { frame: Electron.WebFrameMain; requestId: string } | undefined
  const coordinator: NativeUnload = {
    beforeReload,
    cancelPrepared() {
      if (lastRequest) {
        cancelPreparedUnload(lastRequest.frame, lastRequest.requestId)
      }
    },
    prepare() {
      if (pending) {
        return pending
      }
      if (contents.isDestroyed() || contents.isCrashed()) {
        return Promise.resolve('unreachable')
      }
      const frame = contents.mainFrame
      const requestId = randomUUID()
      lastRequest = { frame, requestId }
      pending = new Promise<PrepareOutcome>((resolve) => {
        const onReply = (
          event: Electron.IpcMainEvent,
          reply: { requestId?: unknown; ok?: unknown }
        ): void => {
          if (
            event.sender === contents &&
            event.senderFrame === frame &&
            contents.mainFrame === frame &&
            reply?.requestId === requestId
          ) {
            settle(reply.ok === true ? 'saved' : 'failed')
          }
        }
        const deadline = setTimeout(() => {
          console.warn('[window] Renderer did not finish its reload checkpoint; reloading anyway')
          // A slow renderer gets its ordinary unload guards back before the reload's beforeunload.
          cancelPreparedUnload(frame, requestId)
          settle('unreachable')
        }, NATIVE_UNLOAD_PREPARE_DEADLINE_MS)
        const settle = (outcome: PrepareOutcome): void => {
          clearTimeout(deadline)
          ipcMain.removeListener('app:native-unload-prepared', onReply)
          settlePending = undefined
          pending = undefined
          resolve(outcome)
        }
        settlePending = settle
        ipcMain.on('app:native-unload-prepared', onReply)
      })
      const prepared = pending
      // Sent after `pending` is assigned so a throwing send clears it instead of caching 'unreachable'.
      try {
        frame.send('app:prepare-native-unload', requestId)
      } catch {
        settlePending?.('unreachable')
      }
      return prepared
    }
  }
  coordinators.set(contents, coordinator)
  contents.on('render-process-gone', () => settlePending?.('unreachable'))
  contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) {
      settlePending?.('superseded')
    }
  })
  // Electron's own listener here reloads directly; replace it so DevTools reload joins the same checkpoint.
  contents.removeAllListeners('devtools-reload-page')
  contents.on('devtools-reload-page', () => {
    void reloadWithRendererCheckpoint(contents).catch(() => {})
  })
  window.on('closed', () => {
    settlePending?.('superseded')
    coordinators.delete(contents)
  })
}

export async function reloadWithRendererCheckpoint(
  contents: WebContents,
  ignoreCache = false,
  beforeReload?: BeforeReload
): Promise<void> {
  // A reload would discard the quit close the renderer is still answering, silently dropping the quit.
  if (closesInFlight.get(contents) === true) {
    return
  }
  const existing = reloads.get(contents)
  if (existing) {
    existing.options.ignoreCache ||= ignoreCache
    return existing.promise
  }
  const options: ReloadOptions = { ignoreCache }
  const coordinator = coordinators.get(contents)
  const reload = (async () => {
    const outcome = (await coordinator?.prepare()) ?? 'unreachable'
    if (outcome === 'failed') {
      throw new Error('Renderer reload was canceled because its state could not be saved.')
    }
    if (outcome === 'superseded' || contents.isDestroyed()) {
      return
    }
    if (options.replacedByClose) {
      coordinator?.cancelPrepared()
      return
    }
    ;(beforeReload ?? coordinator?.beforeReload)?.({
      webContentsId: contents.id,
      ignoreCache: options.ignoreCache
    })
    if (options.ignoreCache) {
      contents.reloadIgnoringCache()
    } else {
      contents.reload()
    }
  })().finally(() => reloads.delete(contents))
  reloads.set(contents, { options, promise: reload })
  return reload
}

/** A close requested mid-reload waits for that checkpoint's verdict, then replaces the reload. */
export function replacePendingReloadWithClose(contents: WebContents): Promise<void> | undefined {
  const pending = reloads.get(contents)
  if (!pending) {
    return undefined
  }
  pending.options.replacedByClose = true
  return pending.promise.catch(() => {})
}
