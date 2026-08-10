import { parseWslUncPath } from '../../shared/wsl-paths'

const MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS = 2

export type WslTranscriptFsTaskPriority = 'exact' | 'scan'

type TaskWaiter<T> = {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ScheduledTask<T> = {
  key: string
  laneKey: string
  priority: WslTranscriptFsTaskPriority
  operation: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  waiters: Set<TaskWaiter<T>>
  state: 'queued' | 'running' | 'settled'
}

type UnknownScheduledTask = ScheduledTask<unknown>

let activeTaskCount = 0
let activeScanCount = 0
const activeLaneKeys = new Set<string>()
const queuedTasks: UnknownScheduledTask[] = []
const inFlightTasks = new Map<string, UnknownScheduledTask>()

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('WSL transcript filesystem task aborted')
}

function routeKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)/i)
  if (match) {
    return `${match[1].toLowerCase()}/${match[2].trim().toLowerCase()}`
  }
  return parseWslUncPath(path)?.distro.trim().toLowerCase() ?? path
}

function removeQueuedTask(task: UnknownScheduledTask): void {
  const index = queuedTasks.indexOf(task)
  if (index !== -1) {
    queuedTasks.splice(index, 1)
  }
}

function clearTask(task: UnknownScheduledTask): void {
  if (inFlightTasks.get(task.key) === task) {
    inFlightTasks.delete(task.key)
  }
}

function abandonTaskIfUnused(task: UnknownScheduledTask): void {
  if (task.waiters.size > 0 || task.state === 'settled') {
    return
  }
  task.controller.abort()
  // Running I/O keeps its permit; new callers need a reusable controller.
  clearTask(task)
  if (task.state === 'queued') {
    task.state = 'settled'
    removeQueuedTask(task)
    pumpTasks()
  }
}

function attachWaiter<T>(task: ScheduledTask<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    abandonTaskIfUnused(task as UnknownScheduledTask)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const waiter: TaskWaiter<T> = { resolve, reject, signal }
    if (signal) {
      waiter.onAbort = () => {
        if (!task.waiters.delete(waiter)) {
          return
        }
        reject(abortReason(signal))
        abandonTaskIfUnused(task as UnknownScheduledTask)
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    task.waiters.add(waiter)
  })
}

function settleTask<T>(task: ScheduledTask<T>, result: { value: T } | { error: unknown }): void {
  if (task.state !== 'running') {
    return
  }
  task.state = 'settled'
  activeTaskCount -= 1
  if (task.priority === 'scan') {
    activeScanCount -= 1
  }
  activeLaneKeys.delete(task.laneKey)
  clearTask(task as UnknownScheduledTask)
  for (const waiter of task.waiters) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    if ('value' in result) {
      waiter.resolve(result.value)
    } else {
      waiter.reject(result.error)
    }
  }
  task.waiters.clear()
  pumpTasks()
}

function nextTaskIndex(): number {
  for (const priority of ['exact', 'scan'] as const) {
    // Why: keep one libuv slot available for a live transcript probe.
    if (priority === 'scan' && activeScanCount > 0) {
      continue
    }
    const index = queuedTasks.findIndex(
      (task) => task.priority === priority && !activeLaneKeys.has(task.laneKey)
    )
    if (index !== -1) {
      return index
    }
  }
  return -1
}

function pumpTasks(): void {
  while (activeTaskCount < MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS) {
    const index = nextTaskIndex()
    if (index === -1) {
      return
    }
    const task = queuedTasks.splice(index, 1)[0]
    if (!task || task.state !== 'queued') {
      continue
    }
    task.state = 'running'
    activeTaskCount += 1
    if (task.priority === 'scan') {
      activeScanCount += 1
    }
    activeLaneKeys.add(task.laneKey)
    void Promise.resolve()
      .then(() => {
        task.controller.signal.throwIfAborted()
        return task.operation(task.controller.signal)
      })
      .then(
        (value) => settleTask(task, { value }),
        (error: unknown) => settleTask(task, { error })
      )
  }
}

/** Bound 9P work without letting scans delay exact transcript probes. */
export function runWslTranscriptFsTask<T>(
  options: {
    operation: 'access' | 'readdir'
    path: string
    priority: WslTranscriptFsTaskPriority
    signal?: AbortSignal
  },
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  // Why: route spelling and Linux path case can change provider behavior, so
  // only byte-identical filesystem requests are safe to share.
  const key = JSON.stringify([options.operation, options.path])
  const existing = inFlightTasks.get(key) as ScheduledTask<T> | undefined
  if (existing) {
    return attachWaiter(existing, options.signal)
  }

  const scheduled: ScheduledTask<T> = {
    key,
    laneKey: `${routeKey(options.path)}:${options.priority}`,
    priority: options.priority,
    operation: task,
    controller: new AbortController(),
    waiters: new Set(),
    state: 'queued'
  }
  inFlightTasks.set(key, scheduled as UnknownScheduledTask)
  const result = attachWaiter(scheduled, options.signal)
  if (scheduled.state === 'queued' && scheduled.waiters.size > 0) {
    queuedTasks.push(scheduled as UnknownScheduledTask)
    queueMicrotask(pumpTasks)
  }
  return result
}
