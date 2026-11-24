import type { BrowserCommandTargetParams } from './browser-command-contracts'

/** A page operation whose caller withdrew it while it waited for page admission. */
export class PageAdmissionCancelledError extends Error {
  constructor() {
    super('Page operation cancelled before admission')
    this.name = 'PageAdmissionCancelledError'
  }
}

// Signals a command registered for its own admission; keyed by the params object it passes on.
const admissionSignals = new WeakMap<BrowserCommandTargetParams, AbortSignal>()

/** Lets a command withdraw its own wait for page admission; the page's load itself continues. */
export function setPageAdmissionSignal(
  params: BrowserCommandTargetParams,
  signal: AbortSignal
): void {
  admissionSignals.set(params, signal)
}

export function pageAdmissionSignal(params: BrowserCommandTargetParams): AbortSignal | undefined {
  return admissionSignals.get(params)
}

export function throwIfAdmissionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PageAdmissionCancelledError()
  }
}

/** Waits for `work`, or rejects as soon as `signal` aborts; `work` keeps running either way. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work
  }
  if (signal.aborted) {
    void work.catch(() => {})
    return Promise.reject(new PageAdmissionCancelledError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => {})
      reject(new PageAdmissionCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
