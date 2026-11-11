import { delayUnlessAborted } from '../../../shared/abort-aware-delay'
import { AcpAgentError } from '../transport/acp-errors'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { AcpPromptTurnTracker } from './acp-session-runtime-options'

const TRACKER_CANCEL_GRACE_MS = 2_000

/** Check whether an ACP RPC failure represents a retryable `session_busy` refusal. */
function sessionBusy(error: unknown): boolean {
  return (
    error instanceof AcpAgentError &&
    error.code === -32003 &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'reason' in error.data &&
    error.data.reason === 'session_busy'
  )
}

/** Retain one logical prompt; only an explicit busy refusal permits another wire attempt. */
export class AcpPromptRequest {
  private active?: AbortController
  private closedWith?: Error
  private waiting = false

  constructor(
    private readonly retryBusy: boolean,
    private readonly cancelGraceMs = TRACKER_CANCEL_GRACE_MS
  ) {}

  get waitingToRetry(): boolean {
    return this.waiting
  }

  /** Execute `request`, coordinating turn-tracker lifecycle and `session_busy` retries. */
  async run(
    request: () => Promise<PromptResponse>,
    tracker?: AcpPromptTurnTracker
  ): Promise<PromptResponse> {
    if (this.active) {
      throw new Error('ACP prompt already in progress')
    }
    const active = new AbortController()
    this.active = active
    try {
      let delayMs = 1_000
      for (;;) {
        if (this.closedWith) {
          throw this.closedWith
        }
        if (active.signal.aborted) {
          return { stopReason: 'cancelled' }
        }
        let trackerActive = false
        let cancelTimer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        try {
          this.waiting = false
          const preparing = tracker?.beginPrompt()
          if (preparing) {
            await preparing
          }
          trackerActive = Boolean(tracker)
          if (this.closedWith || active.signal.aborted) {
            if (trackerActive) {
              trackerActive = false
              await tracker?.abortPrompt()
            }
            if (this.closedWith) {
              throw this.closedWith
            }
            return { stopReason: 'cancelled' }
          }
          if (trackerActive && this.cancelGraceMs >= 0) {
            const scheduleRelease = () => {
              cancelTimer = setTimeout(() => {
                if (trackerActive) {
                  trackerActive = false
                  void Promise.resolve(tracker?.abortPrompt()).catch(() => {})
                }
              }, this.cancelGraceMs)
              cancelTimer.unref?.()
            }
            onAbort = scheduleRelease
            active.signal.addEventListener('abort', onAbort, { once: true })
            if (active.signal.aborted) {
              scheduleRelease()
            }
          }
          const res = await request()
          if (trackerActive && tracker) {
            const finished = await tracker.finishPrompt(res)
            trackerActive = false
            return finished
          }
          return res
        } catch (error) {
          if (trackerActive) {
            trackerActive = false
            await tracker?.abortPrompt()
          }
          if (!this.retryBusy || !sessionBusy(error)) {
            throw error
          }
        } finally {
          if (cancelTimer !== undefined) {
            clearTimeout(cancelTimer)
          }
          if (onAbort) {
            active.signal.removeEventListener('abort', onAbort)
          }
        }
        this.waiting = true
        await delayUnlessAborted(delayMs, active.signal)
        delayMs = Math.min(delayMs * 2, 5_000)
      }
    } finally {
      this.waiting = false
      this.active = undefined
    }
  }

  /** Abort any waiting or preparing prompt turn. */
  cancel(): void {
    this.active?.abort()
  }

  /** Permanently close the prompt runner with `error` and abort any active prompt. */
  close(error: Error): void {
    this.closedWith = error
    this.cancel()
  }
}
