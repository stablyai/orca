import { wslTranscriptFsLaneKey, wslTranscriptFsRouteKey } from './wsl-transcript-fs-route'
import {
  WslTranscriptFsError,
  wslTranscriptFsCapacityError as capacityError,
  wslTranscriptFsTimeoutError as timeoutError,
  wslTranscriptFsUnavailableError as unavailableError
} from './wsl-transcript-fs-error'
import {
  liftRouteQuarantine,
  quarantineRoute,
  resetRouteQuarantinesForTests,
  routeIsBlocked
} from './wsl-transcript-fs-route-quarantine'

const MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS = 2
export const WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS = 30_000
export const WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS = 60_000
// Burst bounds keep polling fan-out from growing retained tasks or callers indefinitely.
export const WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS = 64
export const WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK = 64
export {
  WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE,
  WSL_TRANSCRIPT_FS_SLOW_MESSAGE,
  WslTranscriptFsError,
  wslTranscriptFsRefusal,
  type WslTranscriptFsFailureCode
} from './wsl-transcript-fs-error'
export { WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS } from './wsl-transcript-fs-route-quarantine'

export type WslTranscriptFsTaskPriority = 'exact' | 'scan'

type TaskWaiter<T> = {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  timeout?: ReturnType<typeof setTimeout>
}

type ScheduledTask<T> = {
  key: string
  laneKey: string
  route: string
  priority: WslTranscriptFsTaskPriority
  operation: (signal: AbortSignal) => Promise<T>
  /** Dispose a value no waiter is left to own (see settleTask). */
  onAbandonedResult?: (value: T) => void
  controller: AbortController
  waiters: Set<TaskWaiter<T>>
  state: 'queued' | 'running' | 'settled'
  deadlineTimer?: ReturnType<typeof setTimeout>
  /** When the pump admitted the task; tells the quarantine which incident it saw. */
  startedAt?: number
}

type UnknownScheduledTask = ScheduledTask<unknown>

let activeScanCount = 0
let undedupedTaskId = 0
const activeLaneKeys = new Set<string>()
const queuedTasks: UnknownScheduledTask[] = []
const inFlightTasks = new Map<string, UnknownScheduledTask>()
const activeTasks = new Set<UnknownScheduledTask>()

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('WSL transcript filesystem task aborted')
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

function abandonTaskIfUnused(task: UnknownScheduledTask, reason?: unknown): void {
  if (task.waiters.size > 0 || task.state === 'settled') {
    return
  }
  // Running I/O keeps its permit and its process: an abort here would kill a
  // healthy child and pre-empt the deadline's quarantine. Only the deadline aborts.
  clearTask(task)
  if (task.state === 'queued') {
    task.controller.abort(reason)
    task.state = 'settled'
    removeQueuedTask(task)
    pumpTasks()
  }
}

function removeWaiter<T>(task: ScheduledTask<T>, waiter: TaskWaiter<T>): boolean {
  if (!task.waiters.delete(waiter)) {
    return false
  }
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout)
  }
  return true
}

function timeoutMs(priority: WslTranscriptFsTaskPriority): number {
  return priority === 'exact'
    ? WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS
    : WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS
}

// Why: a task queued behind a quarantined route would otherwise strand until
// its own waiter deadline — one full deadline per file in a sequential scan.
function failQueuedRouteTasks(route: string): void {
  const doomed = queuedTasks.filter((task) => task.route === route && task.state === 'queued')
  for (const task of doomed) {
    task.state = 'settled'
    removeQueuedTask(task)
    clearTask(task)
    for (const waiter of task.waiters) {
      removeWaiter(task, waiter)
      waiter.reject(unavailableError())
    }
  }
}

// Caller-abort pre-checks live in runWslTranscriptFsTask; nothing here yields
// before the waiter is attached, so no aborted-signal recheck is needed.
// The task's own priority is every waiter's deadline: the dedupe key carries
// priority, so a joiner can only ever join a task scheduled at its own.
function attachWaiter<T>(task: ScheduledTask<T>, signal?: AbortSignal): Promise<T> {
  if (task.waiters.size >= WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK) {
    return Promise.reject(capacityError())
  }
  return new Promise<T>((resolve, reject) => {
    const waiter: TaskWaiter<T> = { resolve, reject, signal }
    task.waiters.add(waiter)
    if (signal) {
      waiter.onAbort = () => {
        const reason = abortReason(signal)
        if (!removeWaiter(task, waiter)) {
          return
        }
        reject(reason)
        abandonTaskIfUnused(task as UnknownScheduledTask, reason)
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    // The task deadline also replaces the isolated process; this bounds each caller's own wait.
    waiter.timeout = setTimeout(() => {
      const error = timeoutError()
      if (!removeWaiter(task, waiter)) {
        return
      }
      reject(error)
      abandonTaskIfUnused(task as UnknownScheduledTask, error)
    }, timeoutMs(task.priority))
    waiter.timeout.unref?.()
  })
}

function settleTask<T>(task: ScheduledTask<T>, result: { value: T } | { error: unknown }): void {
  if (task.state !== 'running') {
    // A result that only lands past the deadline is the stall the quarantine
    // was set for, so it never lifts the back-off. A late value also has no
    // owner: dispose it.
    if ('value' in result) {
      try {
        task.onAbandonedResult?.(result.value)
      } catch {
        // Best-effort teardown; nothing left to report it to.
      }
    }
    return
  }
  // Only a settle the deadline did not force proves the mount answered; a
  // transport fault (WslTranscriptFsError from a dead helper) proves nothing.
  if (
    'value' in result ||
    (result.error !== task.controller.signal.reason &&
      !(result.error instanceof WslTranscriptFsError))
  ) {
    liftRouteQuarantine(task.route)
  }
  task.state = 'settled'
  if (task.priority === 'scan') {
    activeScanCount -= 1
  }
  activeLaneKeys.delete(task.laneKey)
  activeTasks.delete(task as UnknownScheduledTask)
  clearTimeout(task.deadlineTimer)
  clearTask(task as UnknownScheduledTask)
  // Why: an unabortable syscall can still succeed after its last waiter timed
  // out or cancelled. A resource-valued result (open's FileHandle) then has no
  // owner left to close it, so ownership passes to the task's disposer.
  const abandoned = task.waiters.size === 0
  for (const waiter of task.waiters) {
    removeWaiter(task, waiter)
    if ('value' in result) {
      waiter.resolve(result.value)
    } else {
      waiter.reject(result.error)
    }
  }
  task.waiters.clear()
  if (abandoned && 'value' in result) {
    // Contained: a disposer that throws must not skip the pump below and wedge
    // every queued task behind this one.
    try {
      task.onAbandonedResult?.(result.value)
    } catch {
      // Best-effort teardown; nothing left to report it to.
    }
  }
  pumpTasks()
}

function nextTaskIndex(): number {
  for (const priority of ['exact', 'scan'] as const) {
    // Why: keep one libuv slot available for a live transcript probe.
    if (priority === 'scan' && activeScanCount > 0) {
      continue
    }
    const index = queuedTasks.findIndex(
      (task) =>
        task.priority === priority &&
        !activeLaneKeys.has(task.laneKey) &&
        !routeIsBlocked(task.route)
    )
    if (index !== -1) {
      return index
    }
  }
  return -1
}

function pumpTasks(): void {
  while (activeTasks.size < MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS) {
    const index = nextTaskIndex()
    if (index === -1) {
      return
    }
    const task = queuedTasks.splice(index, 1)[0]
    if (!task || task.state !== 'queued') {
      continue
    }
    task.state = 'running'
    task.startedAt = performance.now()
    if (task.priority === 'scan') {
      activeScanCount += 1
    }
    activeLaneKeys.add(task.laneKey)
    activeTasks.add(task)
    task.deadlineTimer = setTimeout(() => {
      const error = timeoutError()
      console.warn(
        `[wsl-transcript-fs-gate] ${task.priority} filesystem task exceeded ` +
          `${timeoutMs(task.priority)}ms; replacing its I/O process: ${task.key}`
      )
      // Keep polling from churning replacement processes on the same stalled mount.
      quarantineRoute(task.route, timeoutMs(task.priority), task.startedAt ?? performance.now())
      failQueuedRouteTasks(task.route)
      task.controller.abort(error)
      settleTask(task, { error })
    }, timeoutMs(task.priority))
    task.deadlineTimer.unref?.()
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

/** Test-only: drop every task, route quarantine, and counter. */
export function resetWslTranscriptFsGateForTests(): void {
  for (const task of [...activeTasks, ...queuedTasks]) {
    task.state = 'settled'
    clearTimeout(task.deadlineTimer)
    for (const waiter of task.waiters) {
      removeWaiter(task, waiter)
    }
  }
  activeTasks.clear()
  queuedTasks.length = 0
  inFlightTasks.clear()
  activeLaneKeys.clear()
  resetRouteQuarantinesForTests()
  activeScanCount = 0
}

/** Bound 9P work without letting scans delay exact transcript probes. */
export function runWslTranscriptFsTask<T>(
  options: {
    operation: 'access' | 'readdir' | 'stat' | 'lstat' | 'open' | 'read' | 'readfile'
    path: string
    priority: WslTranscriptFsTaskPriority
    signal?: AbortSignal
    /** Opt out of coalescing when the result is not the whole answer (`open`,
     *  positional `read`): a joiner would share the handle or the buffer. */
    dedupe?: boolean
    /** Release a late result no waiter is left to own (see settleTask). */
    onAbandonedResult?: (value: T) => void
  },
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (options.signal?.aborted) {
    return Promise.reject(abortReason(options.signal))
  }
  // Why: route spelling and Linux path case can change provider behavior, so
  // only byte-identical filesystem requests are safe to share. Priority is part
  // of the key because it selects the task's lane, scan slot and deadline: an
  // exact probe that joined a queued scan task would inherit scan scheduling and
  // starve behind the very traffic the two priorities exist to bypass. A counter
  // key never collides, so an un-deduped task simply never finds a join target.
  const key =
    options.dedupe === false
      ? `undeduped:${++undedupedTaskId}`
      : JSON.stringify([options.operation, options.path, options.priority])
  const existing = inFlightTasks.get(key) as ScheduledTask<T> | undefined
  if (existing) {
    // Join even under a route quarantine: the in-flight task costs no new I/O,
    // is bounded by its own deadline, and its settle may itself lift the
    // quarantine. A queued task cannot linger on a quarantined route —
    // failQueuedRouteTasks cleared it when the quarantine was set.
    return attachWaiter(existing, options.signal)
  }
  const route = wslTranscriptFsRouteKey(options.path)
  if (routeIsBlocked(route)) {
    return Promise.reject(unavailableError())
  }
  if (queuedTasks.length >= WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS) {
    return Promise.reject(capacityError())
  }

  const scheduled: ScheduledTask<T> = {
    key,
    laneKey: wslTranscriptFsLaneKey(options.path, options.priority),
    route,
    priority: options.priority,
    operation: task,
    onAbandonedResult: options.onAbandonedResult,
    controller: new AbortController(),
    waiters: new Set(),
    state: 'queued'
  }
  inFlightTasks.set(key, scheduled as UnknownScheduledTask)
  const result = attachWaiter(scheduled, options.signal)
  queuedTasks.push(scheduled as UnknownScheduledTask)
  queueMicrotask(pumpTasks)
  return result
}
