import { delayUnlessAborted } from '../../shared/concurrency/abort-aware-delay'
import type { ConnectorFailure } from './connector-cloud-request'

// A mixed receiver can refuse again after a successful hello. Bound full inventory restaging.
const PRESENTATION_REHELLO_INTERVAL_MS = 30_000

type Hello = Promise<ConnectorFailure | null>

export class ConnectorPresentationRehello {
  private pending: Hello | null = null
  private nextAt = 0
  private ready = false

  constructor(private readonly signal: AbortSignal) {}

  forPoll(helloRev: number | null): Hello | null {
    return this.ready || helloRev === null ? this.pending : null
  }

  request(say: () => Hello): Hello {
    return (this.pending ??= this.waitAndSay(say).finally(() => {
      this.ready = false
      this.pending = null
    }))
  }

  private async waitAndSay(say: () => Hello): Hello {
    const waitMs = this.nextAt - performance.now()
    if (waitMs > 0) {
      await delayUnlessAborted(waitMs, this.signal)
    }
    if (this.signal.aborted) {
      return null
    }
    this.ready = true
    this.nextAt = performance.now() + PRESENTATION_REHELLO_INTERVAL_MS
    return await say()
  }
}
