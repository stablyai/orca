import { parseWslUncPath } from '../../shared/wsl-paths'

const MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS = 2
export const WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS = 30_000
export const WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS = 60_000
// Burst bounds keep polling fan-out from growing retained tasks or callers indefinitely.
export const WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS = 64
export const WSL_TRANSCRIPT_FS_MAX_WAITERS_PER_TASK = 64
const WSL_TRANSCRIPT_FS_SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'
const WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE =
  'WSL transcript discovery is temporarily unavailable because too many filesystem requests are already waiting. Try again shortly or restart Orca if the issue continues.'

export type WslTranscriptFsFailureCode = 'timeout' | 'capacity' | 'unavailable'

export class WslTranscriptFsError extends Error {
  constructor(
    readonly code: WslTranscriptFsFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'WslTranscriptFsError'
  }
}

/** Narrow a caught error to a gate refusal, rethrowing anything else. */
export function wslTranscriptFsRefusal(error: unknown): WslTranscriptFsError {
  if (error instanceof WslTranscriptFsError) {
    return error
  }
  throw error
}

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
  controller: AbortController
  waiters: Set<TaskWaiter<T>>
  state: 'queued' | 'running' | 'settled'
  // Set by the deadline timer, sharing the waiters' monotonic clock — wall time
  // would misjudge stuckness across laptop sleep or NTP steps.
  stuck: boolean
  stuckTimer?: ReturnType<typeof setTimeout>
}

type UnknownScheduledTask = ScheduledTask<unknown>

let activeScanCount = 0
const activeLaneKeys = new Set<string>()
const queuedTasks: UnknownScheduledTask[] = []
const inFlightTasks = new Map<string, UnknownScheduledTask>()
const activeTasks = new Set<UnknownScheduledTask>()

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('WSL transcript filesystem task aborted')
}

// wsl$ and wsl.localhost spellings of one distro stay distinct routes on
// purpose (provider spelling can change behavior), so a stuck spelling never
// fast-fails its twin — the twin is bounded by its own waiter deadlines.
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

function abandonTaskIfUnused(task: UnknownScheduledTask, reason?: unknown): void {
  if (task.waiters.size > 0 || task.state === 'settled') {
    return
  }
  task.controller.abort(reason)
  // Running I/O keeps its permit; new callers need a reusable controller.
  clearTask(task)
  if (task.state === 'queued') {
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

function timeoutError(): WslTranscriptFsError {
  return new WslTranscriptFsError('timeout', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

function capacityError(): WslTranscriptFsError {
  return new WslTranscriptFsError('capacity', WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE)
}

function unavailableError(): WslTranscriptFsError {
  return new WslTranscriptFsError('unavailable', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

/**
 * The stuck running task that would doom a new task's admission: one on the
 * same route (the whole distro mount is hung, whatever the priority — spending
 * the other permit on it escalates one bad distro into a global outage), one
 * holding the single scan slot, or (with every permit stuck) any permit.
 */
function stuckBlocker(
  route: string,
  priority: WslTranscriptFsTaskPriority
): UnknownScheduledTask | undefined {
  const stuck = [...activeTasks].filter((task) => task.stuck)
  if (stuck.length === MAX_CONCURRENT_WSL_TRANSCRIPT_FS_TASKS) {
    return stuck[0]
  }
  return stuck.find(
    (task) => task.route === route || (priority === 'scan' && task.priority === 'scan')
  )
}

// Caller-abort pre-checks live in runWslTranscriptFsTask; nothing here yields
// before the waiter is attached, so no aborted-signal recheck is needed.
function attachWaiter<T>(
  task: ScheduledTask<T>,
  priority: WslTranscriptFsTaskPriority,
  signal?: AbortSignal
): Promise<T> {
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
    // UNC/9P calls cannot be aborted; two blocked calls can retain both slots until settling or
    // Orca restarts, while caller and queue retention remains bounded.
    waiter.timeout = setTimeout(() => {
      const error = timeoutError()
      if (!removeWaiter(task, waiter)) {
        return
      }
      reject(error)
      abandonTaskIfUnused(task as UnknownScheduledTask, error)
    }, timeoutMs(priority))
    waiter.timeout.unref?.()
  })
}

function settleTask<T>(task: ScheduledTask<T>, result: { value: T } | { error: unknown }): void {
  if (task.state !== 'running') {
    return
  }
  task.state = 'settled'
  if (task.priority === 'scan') {
    activeScanCount -= 1
  }
  activeLaneKeys.delete(task.laneKey)
  activeTasks.delete(task as UnknownScheduledTask)
  clearTimeout(task.stuckTimer)
  clearTask(task as UnknownScheduledTask)
  for (const waiter of task.waiters) {
    removeWaiter(task, waiter)
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
  // Tasks queued before their route hung must not be fed the other permit;
  // their waiters drain by deadline while healthy routes use the slot.
  const stuckRoutes = new Set(
    [...activeTasks].filter((task) => task.stuck).map((task) => task.route)
  )
  for (const priority of ['exact', 'scan'] as const) {
    // Why: keep one libuv slot available for a live transcript probe.
    if (priority === 'scan' && activeScanCount > 0) {
      continue
    }
    const index = queuedTasks.findIndex(
      (task) =>
        task.priority === priority &&
        !activeLaneKeys.has(task.laneKey) &&
        !stuckRoutes.has(task.route)
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
    if (task.priority === 'scan') {
      activeScanCount += 1
    }
    activeLaneKeys.add(task.laneKey)
    activeTasks.add(task)
    // Anchored at run start: queue wait says nothing about the I/O itself, so
    // the fail-fast may lag admission by at most one deadline period.
    task.stuckTimer = setTimeout(() => {
      task.stuck = true
      console.warn(
        `[wsl-transcript-fs-gate] ${task.priority} filesystem task still running after ` +
          `${timeoutMs(task.priority)}ms and holding a permit: ${task.key}`
      )
    }, timeoutMs(task.priority))
    task.stuckTimer.unref?.()
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
  if (options.signal?.aborted) {
    return Promise.reject(abortReason(options.signal))
  }
  // Why: route spelling and Linux path case can change provider behavior, so
  // only byte-identical filesystem requests are safe to share.
  const key = JSON.stringify([options.operation, options.path])
  const existing = inFlightTasks.get(key) as ScheduledTask<T> | undefined
  if (existing) {
    // A stuck target — or a queued target that stuck I/O keeps from ever
    // running — dooms every joiner to a slow timeout, and each fresh joiner
    // would keep the queued task alive past its own abandonment. Fail fast.
    if (
      existing.stuck ||
      (existing.state === 'queued' && stuckBlocker(existing.route, existing.priority))
    ) {
      return Promise.reject(unavailableError())
    }
    return attachWaiter(existing, options.priority, options.signal)
  }
  const route = routeKey(options.path)
  // Fail fast when the permit, route, or scan slot this task needs is held by
  // stuck I/O — queueing would only burn the caller's full deadline.
  if (stuckBlocker(route, options.priority)) {
    return Promise.reject(unavailableError())
  }
  if (queuedTasks.length >= WSL_TRANSCRIPT_FS_MAX_PENDING_TASKS) {
    return Promise.reject(capacityError())
  }

  const scheduled: ScheduledTask<T> = {
    key,
    laneKey: `${route}:${options.priority}`,
    route,
    priority: options.priority,
    operation: task,
    controller: new AbortController(),
    waiters: new Set(),
    state: 'queued',
    stuck: false
  }
  inFlightTasks.set(key, scheduled as UnknownScheduledTask)
  const result = attachWaiter(scheduled, options.priority, options.signal)
  queuedTasks.push(scheduled as UnknownScheduledTask)
  queueMicrotask(pumpTasks)
  return result
}
