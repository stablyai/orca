import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from '../../../shared/quit-teardown-deadline'

type BeforeReload = (options: { webContentsId: number; ignoreCache: boolean }) => void
/** saved: durable; failed: renderer refused (cancel); unreachable: reload as before; superseded: document already gone. */
type PrepareOutcome = 'saved' | 'failed' | 'unreachable' | 'superseded'
type NativeUnload = { prepare(): Promise<PrepareOutcome>; beforeReload?: BeforeReload }

// Quit's frozen-renderer bound plus the checkpoint flush deadline, so a live renderer still gets main's durable verdict.
export const NATIVE_UNLOAD_PREPARE_DEADLINE_MS =
  QUIT_RENDERER_ACK_TIMEOUT_MS + WILL_QUIT_TEARDOWN_DEADLINE_MS

const reloads = new WeakMap<
  WebContents,
  { options: { ignoreCache: boolean }; promise: Promise<void> }
>()
const coordinators = new WeakMap<WebContents, NativeUnload>()

/** Native reloads join the document's durable checkpoint, like the renderer's own restart/reload. */
export function installNativeUnloadCoordinator(
  window: BrowserWindow,
  beforeReload?: BeforeReload
): void {
  const contents = window.webContents
  let pending: Promise<PrepareOutcome> | undefined
  let settlePending: ((outcome: PrepareOutcome) => void) | undefined
  const coordinator: NativeUnload = {
    beforeReload,
    prepare() {
      if (pending) {
        return pending
      }
      if (contents.isDestroyed() || contents.isCrashed()) {
        return Promise.resolve('unreachable')
      }
      const frame = contents.mainFrame
      const requestId = randomUUID()
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
          try {
            // Lets a slow renderer restore its ordinary unload guards before the reload's beforeunload.
            frame.send('app:native-unload-expired', requestId)
          } catch {
            // Frame already gone; the reload below proceeds as before.
          }
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
        try {
          frame.send('app:prepare-native-unload', requestId)
        } catch {
          settle('unreachable')
        }
      })
      return pending
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
  const existing = reloads.get(contents)
  if (existing) {
    existing.options.ignoreCache ||= ignoreCache
    return existing.promise
  }
  const options = { ignoreCache }
  const coordinator = coordinators.get(contents)
  const reload = (async () => {
    const outcome = (await coordinator?.prepare()) ?? 'unreachable'
    if (outcome === 'failed') {
      throw new Error('Renderer reload was canceled because its state could not be saved.')
    }
    if (outcome === 'superseded' || contents.isDestroyed()) {
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
