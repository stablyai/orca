import { ipcMain } from 'electron'
import {
  BROWSER_EXTENSION_INVOKE_CHANNEL,
  type BrowserExtensionInvokeResult
} from '../../../shared/browser-extension-channels'
import { parseChromeExtensionUrl } from '../../../shared/browser-extension-url'
import { BROWSER_EXTENSION_API_SCHEME } from '../../../shared/browser-extension-worker-api'
import type { BrowserExtensionCaller } from './browser-extension-namespace-registry'
import { detachWorkerEventStream } from './browser-extension-worker-event-stream'
import {
  dispatchBrowserExtensionEvent,
  dispatchToWorkerWhenListening,
  ensureHostSessionState,
  ensureWorkerContext,
  forgetExtensionContexts,
  forgetHostSession,
  getHostSessionState,
  type BrowserExtensionEventArgs,
  type BrowserExtensionEventTarget,
  type HostSessionState,
  type WorkerContext
} from './browser-extension-contexts'
import { handleBrowserExtensionApiRequest } from './browser-extension-api-request'
import { handleBrowserExtensionWorkerRequest } from './browser-extension-worker-api-host'

function resolveFrameCaller(event: Electron.IpcMainInvokeEvent): {
  caller: BrowserExtensionCaller
  state: HostSessionState
  frame: Electron.WebFrameMain
} | null {
  const frame = event.senderFrame
  if (!frame || frame.isDestroyed()) {
    return null
  }
  const parsed = parseChromeExtensionUrl(frame.url)
  const sess = event.sender.session
  const state = getHostSessionState(sess)
  const extension = parsed && state ? sess.extensions.getExtension(parsed.extensionId) : null
  if (!extension || !state) {
    return null
  }
  return {
    caller: {
      extension,
      session: sess,
      browserProfileId: state.browserProfileId,
      webContents: event.sender,
      frame
    },
    state,
    frame
  }
}

/** Installs the frame-side handler once; workers call through each session's protocol handler. */
export function installBrowserExtensionApiHost(): void {
  ipcMain.removeHandler(BROWSER_EXTENSION_INVOKE_CHANNEL)
  ipcMain.handle(BROWSER_EXTENSION_INVOKE_CHANNEL, async (event, request: unknown) => {
    const resolved = resolveFrameCaller(event)
    if (!resolved) {
      return { ok: false, error: 'Not an extension context' } satisfies BrowserExtensionInvokeResult
    }
    const { caller, state, frame } = resolved
    return handleBrowserExtensionApiRequest(caller, state, request, {
      kind: 'frame',
      webContents: event.sender,
      frame
    })
  })
}

/** Tracks the running worker so calls and events can extend its lifetime with startTask(). */
function attachWorker(
  sess: Electron.Session,
  state: HostSessionState,
  worker: Electron.ServiceWorkerMain
): void {
  const parsed = parseChromeExtensionUrl(worker.scope)
  if (!parsed || !sess.extensions.getExtension(parsed.extensionId)) {
    return
  }
  ensureWorkerContext(state, parsed.extensionId, worker.scope).running = worker
}

function startWorker(sess: Electron.Session, context: WorkerContext): void {
  const state = getHostSessionState(sess)
  if (!state || context.starting) {
    return
  }
  context.starting = true
  sess.serviceWorkers
    .startWorkerForScope(context.scope)
    .then((worker) => attachWorker(sess, state, worker))
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not start extension worker:', error)
    })
    .finally(() => {
      context.starting = false
    })
}

// Why sweep: an extension's worker can start before the status listener exists.
function sweepRunningWorkers(sess: Electron.Session, state: HostSessionState): void {
  for (const versionId of Object.keys(sess.serviceWorkers.getAllRunning())) {
    const worker = sess.serviceWorkers.getWorkerFromVersionID(Number(versionId))
    if (worker) {
      attachWorker(sess, state, worker)
    }
  }
}

const listenedSessions = new WeakSet<Electron.Session>()

// Why once per session, reading state at event time: the session outlives its host state when
// extensions are switched off and on, and a second set of listeners would act twice.
function listenToSession(sess: Electron.Session): void {
  if (listenedSessions.has(sess)) {
    return
  }
  listenedSessions.add(sess)
  sess.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    const state = getHostSessionState(sess)
    if (!state) {
      return
    }
    if (runningStatus === 'starting' || runningStatus === 'running') {
      const worker = sess.serviceWorkers.getWorkerFromVersionID(versionId)
      if (worker) {
        attachWorker(sess, state, worker)
      }
    } else if (runningStatus === 'stopped') {
      // Why: a stopped worker drops sends; clearing it makes the next event restart and queue.
      for (const context of state.workers.values()) {
        const running = context.running
        if (running && (running.isDestroyed() || running.versionId === versionId)) {
          context.running = null
          detachWorkerEventStream(context)
        }
      }
    }
  })
  sess.extensions.on('extension-ready', () => {
    const state = getHostSessionState(sess)
    if (state) {
      sweepRunningWorkers(sess, state)
    }
  })
  sess.extensions.on('extension-unloaded', (_event, extension) =>
    forgetExtensionContexts(sess, extension.id)
  )
}

/** Called by the session loader whenever a local browser-profile session starts running extensions. */
export function attachBrowserExtensionApiHostToSession(
  sess: Electron.Session,
  browserProfileId: string
): void {
  if (getHostSessionState(sess)) {
    return
  }
  const state = ensureHostSessionState(sess, browserProfileId)
  listenToSession(sess)
  sess.protocol.handle(BROWSER_EXTENSION_API_SCHEME, (request) =>
    getHostSessionState(sess) === state
      ? handleBrowserExtensionWorkerRequest(sess, state, request)
      : Promise.resolve(new Response(null, { status: 403 }))
  )
  sweepRunningWorkers(sess, state)
}

export function forgetBrowserExtensionContexts(sess: Electron.Session): void {
  forgetHostSession(sess)
  sess.protocol.unhandle(BROWSER_EXTENSION_API_SCHEME)
}

export function getBrowserExtensionProfileIdForSession(sess: Electron.Session): string | null {
  return getHostSessionState(sess)?.browserProfileId ?? null
}

/**
 * The one way to raise an extension event. Delivery goes only to contexts that listen for it;
 * a stopped worker that listens is started and gets the event once it re-registers.
 * `matchesFilter` skips contexts none of whose listener filters match (webRequest).
 */
export function emitBrowserExtensionEvent(
  target: BrowserExtensionEventTarget,
  namespace: string,
  event: string,
  args: BrowserExtensionEventArgs,
  matchesFilter?: (filter: unknown) => boolean
): void {
  dispatchBrowserExtensionEvent(target, namespace, event, args, startWorker, matchesFilter)
}

/** Raises an event the worker hears once its top-level listener registers; unheard ones expire. */
export function emitBrowserExtensionWorkerStartEvent(
  sess: Electron.Session,
  extensionId: string,
  namespace: string,
  event: string,
  args: unknown[]
): void {
  dispatchToWorkerWhenListening(sess, extensionId, namespace, event, args, startWorker)
}
