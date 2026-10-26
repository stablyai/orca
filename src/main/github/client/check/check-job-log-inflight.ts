import { createCheckDetailsAbortError, waitForCheckDetailsResolution } from './check-details-abort'
import { assertCheckLogActive } from './check-job-log-download'

type Subscriber = { settle: (value?: string, error?: Error) => void; active: () => boolean }
type Entry = {
  token: symbol
  terminated: Promise<void>
  retiring: boolean
  resultSettled: boolean
  closed: boolean
  subscribers?: Map<symbol, Subscriber>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
}
const inflight = new Map<string, Entry>()

function removeClosed(key: string, entry: Entry): void {
  if (entry.closed && entry.resultSettled && inflight.get(key)?.token === entry.token) {
    inflight.delete(key)
  }
}

function retire(entry: Entry, error?: Error): void {
  if (entry.retiring) {
    return
  }
  entry.retiring = true
  clearTimeout(entry.timer)
  entry.timer = undefined
  if (error) {
    entry.controller?.abort()
  }
  entry.controller = undefined
  const subscribers = entry.subscribers
  entry.subscribers = undefined
  if (error) {
    for (const subscriber of subscribers?.values() ?? []) {
      subscriber.settle(undefined, error)
    }
  }
}

function subscribe(entry: Entry, signal: AbortSignal, deadlineAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = Symbol('check-log-reader')
    let settled = false
    const settle = (value?: string, error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      entry.subscribers?.delete(token)
      if (error) {
        reject(error)
      } else if (signal.aborted || Date.now() >= deadlineAt) {
        reject(createCheckDetailsAbortError())
      } else {
        resolve(value ?? '')
      }
      if (!entry.retiring && entry.subscribers?.size === 0) {
        retire(entry, createCheckDetailsAbortError())
      }
    }
    const onAbort = (): void => settle(undefined, createCheckDetailsAbortError())
    const timer = setTimeout(onAbort, Math.max(0, deadlineAt - Date.now()))
    entry.subscribers?.set(token, {
      settle,
      active: () => !signal.aborted && Date.now() < deadlineAt
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted || Date.now() >= deadlineAt) {
      onAbort()
    }
  })
}

type SharedRequest = {
  key: string
  signal: AbortSignal
  deadlineAt: number
  cached: () => string | undefined
  publish: (value: string) => void
  start: (
    signal: AbortSignal,
    deadlineAt: number
  ) => {
    result: Promise<string>
    terminated: Promise<void>
  }
}

function startEntry(request: SharedRequest): Promise<string> {
  const controller = new AbortController()
  let finish = (): void => {}
  const terminated = new Promise<void>((resolve) => {
    finish = resolve
  })
  const entry: Entry = {
    token: Symbol('check-log-operation'),
    terminated,
    retiring: false,
    resultSettled: false,
    closed: false,
    subscribers: new Map(),
    controller
  }
  inflight.set(request.key, entry)
  const result = subscribe(entry, request.signal, request.deadlineAt)
  entry.timer = setTimeout(
    () => retire(entry, new Error('Could not load job logs.')),
    Math.max(0, request.deadlineAt - Date.now())
  )
  // First reader and lifetime are registered before the runner can start a child.
  const operation = request.start(controller.signal, request.deadlineAt)
  void operation.result.then(
    (value) => {
      if (!entry.retiring && !controller.signal.aborted && Date.now() < request.deadlineAt) {
        const subscribers = entry.subscribers
        if ([...(subscribers?.values() ?? [])].some((subscriber) => subscriber.active())) {
          request.publish(value)
        }
        retire(entry)
        for (const subscriber of subscribers?.values() ?? []) {
          subscriber.settle(value)
        }
      } else {
        retire(entry, new Error('Could not load job logs.'))
      }
      entry.resultSettled = true
      removeClosed(request.key, entry)
    },
    () => {
      retire(entry, new Error('Could not load job logs.'))
      entry.resultSettled = true
      removeClosed(request.key, entry)
    }
  )
  watchTermination(request.key, entry, operation.terminated, finish)
  return result
}

function watchTermination(
  key: string,
  entry: Entry,
  terminated: Promise<void>,
  finish: () => void
): void {
  void terminated.then(() => {
    entry.closed = true
    finish()
    removeClosed(key, entry)
  })
}

async function waitForRetirement(
  entry: Entry,
  signal: AbortSignal,
  deadlineAt: number
): Promise<void> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, Math.max(0, deadlineAt - Date.now()))
  if (signal.aborted) {
    onAbort()
  }
  try {
    await waitForCheckDetailsResolution(entry.terminated, controller.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export async function requestSharedCheckJobLog(request: SharedRequest): Promise<string> {
  for (;;) {
    assertCheckLogActive(request.signal, request.deadlineAt)
    const cached = request.cached()
    if (cached !== undefined) {
      return cached
    }
    const entry = inflight.get(request.key)
    if (!entry) {
      return startEntry(request)
    }
    if (!entry.retiring) {
      return subscribe(entry, request.signal, request.deadlineAt)
    }
    await waitForRetirement(entry, request.signal, request.deadlineAt)
    assertCheckLogActive(request.signal, request.deadlineAt)
  }
}
