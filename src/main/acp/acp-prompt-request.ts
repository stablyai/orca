import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import { AcpAgentError } from './acp-errors'
import type { PromptResponse } from './generated/acp-protocol.generated'

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

  constructor(private readonly retryBusy: boolean) {}

  async run(request: () => Promise<PromptResponse>): Promise<PromptResponse> {
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
          return await request()
        } catch (error) {
          if (!this.retryBusy || !sessionBusy(error)) {
            throw error
          }
        }
        await delayUnlessAborted(delayMs, active.signal)
        delayMs = Math.min(delayMs * 2, 5_000)
      }
    } finally {
      if (this.active === active) {
        this.active = undefined
      }
    }
  }

  cancel(): void {
    this.active?.abort()
  }

  close(error: Error): void {
    this.closedWith = error
    this.cancel()
  }
}
