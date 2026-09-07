import { RuntimeClientError } from './runtime-client-error'

/**
 * Serializes operations onto one helper and bounds how long one may wait its
 * turn.
 *
 * Why the wait needs its own deadline: the in-flight timeout is armed only once
 * a request reaches a helper, so a request behind N timing-out ones waited N
 * times that timeout with no deadline of its own — bounded, but the caller sees
 * an `await` that looks hung for minutes and gets no error to act on.
 *
 * Why only the wait: a request that reaches a helper still gets its full
 * execution budget. A single deadline covering both would fail operations that
 * queued briefly and would otherwise have succeeded.
 */
export class DesktopScriptRequestQueue {
  /**
   * Never rejects: downstream turns chain onto it, and a rejection here would
   * be delivered to whichever request happened to queue behind the failure.
   */
  private tail: Promise<void> | null = null

  constructor(
    private readonly waitTimeoutMs: number,
    /** Called when the queue empties, so the host can arm its idle shutdown. */
    private readonly onDrained: () => void
  ) {}

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.tail
    if (!queued) {
      return this.track(run())
    }
    let expiry: RuntimeClientError | null = null
    let waitTimer: NodeJS.Timeout | undefined
    const waited = new Promise<never>((_resolve, reject) => {
      waitTimer = setTimeout(() => {
        expiry = new RuntimeClientError(
          'action_timeout',
          `desktop provider timed out after ${this.waitTimeoutMs}ms waiting for earlier operations`
        )
        reject(expiry)
      }, this.waitTimeoutMs)
      waitTimer.unref?.()
    })
    // An abandoned request is never handed to a helper. The caller has already
    // been told it failed, and a click delivered after that is worse than none.
    const turn = (): Promise<T> => {
      clearTimeout(waitTimer)
      return expiry ? Promise.reject(expiry) : run()
    }
    // The tail chains on the turn, not on the race: a caller giving up early
    // must not release the next request while this one's predecessor is still
    // in flight.
    return Promise.race([waited, this.track(queued.then(turn, turn))])
  }

  private track<T>(result: Promise<T>): Promise<T> {
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tail = tail
    void tail.finally(() => {
      if (this.tail !== tail) {
        return
      }
      this.tail = null
      this.onDrained()
    })
    return result
  }
}
