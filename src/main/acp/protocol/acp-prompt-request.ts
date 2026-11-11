import { delayUnlessAborted } from '../../../shared/abort-aware-delay'
import { AcpAgentError } from '../transport/acp-errors'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { AcpPromptTurnTracker } from './acp-session-runtime-options'

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

  constructor(private readonly retryBusy: boolean) {}

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
        try {
          this.waiting = false
          const preparing = tracker?.beginPrompt()
          if (preparing) {
            await preparing
            if (this.closedWith || active.signal.aborted) {
              const aborting = tracker?.abortPrompt()
              if (aborting) {
                await aborting
              }
              if (this.closedWith) {
                throw this.closedWith
              }
              return { stopReason: 'cancelled' }
            }
          }
          const res = await request()
          return tracker ? await tracker.finishPrompt(res) : res
        } catch (error) {
          const aborting = tracker?.abortPrompt()
          if (aborting) {
            await aborting
          }
          if (!this.retryBusy || !sessionBusy(error)) {
            throw error
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
