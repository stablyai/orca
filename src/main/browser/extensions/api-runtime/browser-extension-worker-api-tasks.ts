import type { BrowserExtensionExecution } from './browser-extension-execution-authority'

type End = () => void
const byWorker = new WeakMap<Electron.ServiceWorkerMain, Set<End>>()
const byExecution = new WeakMap<BrowserExtensionExecution, { tasks: Set<End>; abort: End }>()

/** The session's existing native stop observer releases tasks belonging to that exact worker. */
export function endBrowserExtensionWorkerApiTasks(worker: Electron.ServiceWorkerMain): void {
  for (const end of byWorker.get(worker) ?? []) {
    end()
  }
}

export function startBrowserExtensionWorkerApiTask(
  worker: Electron.ServiceWorkerMain | null,
  request: unknown,
  execution: BrowserExtensionExecution
): Electron.StartTask | null {
  if (!worker || worker.isDestroyed()) {
    return null
  }
  let native: Electron.StartTask
  try {
    native = worker.startTask()
  } catch {
    return null
  }
  const signal = execution.controller.signal
  const workerTasks = byWorker.get(worker) ?? new Set<End>()
  byWorker.set(worker, workerTasks)
  let owner = byExecution.get(execution)
  if (!owner) {
    const tasks = new Set<End>()
    owner = {
      tasks,
      abort: () => {
        for (const end of tasks) {
          end()
        }
      }
    }
    byExecution.set(execution, owner)
    signal.addEventListener('abort', owner.abort, { once: true })
  }
  const executionTasks = owner
  let ended = false
  let timer: NodeJS.Timeout | undefined
  const end = (): void => {
    if (ended) {
      return
    }
    ended = true
    clearTimeout(timer)
    workerTasks.delete(end)
    executionTasks.tasks.delete(end)
    if (workerTasks.size === 0) {
      byWorker.delete(worker)
    }
    if (executionTasks.tasks.size === 0) {
      signal.removeEventListener('abort', executionTasks.abort)
      byExecution.delete(execution)
    }
    try {
      native.end()
    } catch {
      /* The captured native worker has stopped. */
    }
  }
  workerTasks.add(end)
  executionTasks.tasks.add(end)
  // Native API requests release their keepalive after five minutes; permission prompts are exempt.
  const permissionPrompt =
    request !== null &&
    typeof request === 'object' &&
    'type' in request &&
    request.type === 'call' &&
    'namespace' in request &&
    request.namespace === 'permissions' &&
    'method' in request &&
    request.method === 'request'
  if (!permissionPrompt) {
    timer = setTimeout(end, 5 * 60 * 1000)
    timer.unref()
  }
  if (signal.aborted) {
    end()
  }
  return { end }
}
