import { endBrowserExtensionWorkerApiTasks } from './browser-extension-worker-api-tasks'
import { parseChromeExtensionUrl } from '../../../../shared/browser/extensions/browser-extension-url'
import {
  getBrowserExtensionExecution,
  isBrowserExtensionExecutionLive,
  awaitBrowserExtensionExecution,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'
import {
  ensureWorkerContext,
  type HostSessionState,
  type WorkerContext
} from './browser-extension-contexts'
import {
  beginWorkerPublication,
  detachWorkerEventStream
} from './browser-extension-worker-event-stream'

const stoppedWorkers = new WeakSet<Electron.ServiceWorkerMain>()

/** Tracks the running worker so calls and events can extend its lifetime with startTask(). */
export function attachBrowserExtensionWorker(
  sess: Electron.Session,
  state: HostSessionState,
  worker: Electron.ServiceWorkerMain
): void {
  const parsed = parseChromeExtensionUrl(worker.scope)
  const extension = parsed && sess.extensions.getExtension(parsed.extensionId)
  if (!parsed || !extension || stoppedWorkers.has(worker)) {
    return
  }
  const execution = getBrowserExtensionExecution(sess, parsed.extensionId)
  if (
    !execution ||
    execution.host !== state ||
    !isBrowserExtensionExecutionLive(execution) ||
    worker.isDestroyed()
  ) {
    return
  }
  const context = ensureWorkerContext(state, parsed.extensionId, worker.scope)
  if (context.running !== worker || !context.run || context.run.signal.aborted) {
    const restarted = context.run !== undefined
    context.run?.abort()
    context.run = new AbortController()
    beginWorkerPublication(context, restarted)
  }
  context.execution = execution
  context.extension = extension
  context.running = worker
}

export async function startBrowserExtensionWorker(
  execution: BrowserExtensionExecution,
  context: WorkerContext
): Promise<Electron.ServiceWorkerMain> {
  const sess = execution.session
  await awaitBrowserExtensionExecution(execution, execution.workerRegistration ?? Promise.resolve())
  execution.controller.signal.throwIfAborted()
  let worker: Electron.ServiceWorkerMain | undefined
  let observedRunning: Electron.ServiceWorkerMain | undefined
  let resolveRun!: () => void
  let rejectRun!: (error: Error) => void
  const running = new Promise<void>((resolve, reject) => {
    resolveRun = resolve
    rejectRun = reject
  })
  // The native start callback precedes the asynchronously posted running inventory update.
  const statusChanged = ({
    versionId,
    runningStatus
  }: Electron.ServiceWorkersRunningStatusChangedEventParams): void => {
    if (runningStatus === 'running') {
      observedRunning = sess.serviceWorkers.getWorkerFromVersionID(versionId)
      if (worker && observedRunning === worker) {
        resolveRun()
      }
    } else if (runningStatus === 'stopping' || runningStatus === 'stopped') {
      if (observedRunning?.versionId === versionId) {
        observedRunning = undefined
      }
      if (worker?.versionId === versionId) {
        rejectRun(new Error('Extension worker stopped while starting'))
      }
    }
  }
  sess.serviceWorkers.on('running-status-changed', statusChanged)
  // Observe rejection even if native scope start itself rejects first.
  void running.catch(() => {})
  try {
    worker = await awaitBrowserExtensionExecution(
      execution,
      sess.serviceWorkers.startWorkerForScope(context.scope)
    )
    if (worker.isDestroyed() || worker.scope !== context.scope) {
      throw new Error('Extension worker is unavailable')
    }
    if (
      !stoppedWorkers.has(worker) &&
      (observedRunning === worker || sess.serviceWorkers.getAllRunning()[worker.versionId])
    ) {
      resolveRun()
    }
    await awaitBrowserExtensionExecution(execution, running)
    if (
      !isBrowserExtensionExecutionLive(execution) ||
      execution.host.workers.get(execution.extensionId) !== context ||
      worker.isDestroyed() ||
      stoppedWorkers.has(worker)
    ) {
      throw new Error('Extension worker is unavailable')
    }
    attachBrowserExtensionWorker(sess, execution.host, worker)
    return worker
  } catch (error) {
    context.initialPublication = false
    context.queue = context.queue.filter((entry) => !entry.provisional)
    context.pendingLifecycle = []
    throw error
  } finally {
    sess.serviceWorkers.removeListener('running-status-changed', statusChanged)
  }
}

export function noteBrowserExtensionWorkerRunning(worker: Electron.ServiceWorkerMain): void {
  stoppedWorkers.delete(worker)
}

export function stopBrowserExtensionWorker(context: WorkerContext): void {
  const worker = context.running
  if (!worker) {
    return
  }
  stoppedWorkers.add(worker)
  endBrowserExtensionWorkerApiTasks(worker)
  context.run?.abort()
  context.running = null
  context.initialPublication = false
  context.queue = context.queue.filter((entry) => !entry.provisional)
  detachWorkerEventStream(context)
}
