import type {
  RelayDialStage,
  RelayDialStageTracker,
  RelayDialStageTiming
} from './relay-dial-stage'
import type { ConnectionLogSink } from './types'

// Why: support needs per-stage durations for a slow dial, and the name of the stage
// a failed dial died in, without a debug build. Timing only — advancing the tracker
// stays the session's call.
export class RelayDialStageLog {
  private sequence = 0

  constructor(
    private readonly tracker: RelayDialStageTracker,
    private readonly sessionId: string,
    private readonly sink?: ConnectionLogSink
  ) {}

  enter(stage: RelayDialStage): void {
    this.record(this.tracker.advance(stage))
  }

  settle(complete: boolean, failureDetail?: string): void {
    this.record(this.tracker.settle(complete), failureDetail)
  }

  private record(timing: RelayDialStageTiming | null, failureDetail?: string): void {
    if (!timing) {
      return
    }
    // Why: this runs inside the dial's success and failure paths. A sink that
    // throws must not turn a good connect into a failed one.
    try {
      this.sink?.({
        id: `relay-dial-stage-${this.sessionId}-${++this.sequence}`,
        ts: Date.now(),
        level: timing.complete ? 'info' : 'warn',
        path: 'relay',
        message: `Relay dial stage ${timing.stage} ${
          timing.complete ? 'finished' : 'did not finish'
        }`,
        detail: `${timing.ms}ms${failureDetail ? ` — ${failureDetail}` : ''}`,
        timing: {
          kind: 'relay-dial-stage',
          name: timing.stage,
          ms: timing.ms,
          complete: timing.complete
        }
      })
    } catch {
      // Diagnostics only; a broken sink is not worth failing a dial over.
    }
  }
}
