import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'

// Models may pause this long between frames mid-reply.
const QUIET_MS = 20_000
// Running calls may be slow commands; past this they continue as background tasks.
const CALL_QUIET_MS = 120_000

type AcpAgentTurnLane = {
  readonly translator: AcpTimelineTranslator
  apply(events: readonly ProviderTimelineEvent[]): void
}

/** Unprompted agent work has no end of its own; quiet, Stop or the next send ends it. */
export class AcpAgentTurnQuiet {
  private timer: ReturnType<typeof setTimeout> | null = null
  private asking = false
  private disposed = false

  constructor(
    private readonly lane: AcpAgentTurnLane,
    private readonly now: () => number
  ) {}

  /** Lane activity restarts the quiet period; an open request waits for its person. */
  restart(): void {
    this.stop()
    const calls = this.lane.translator.agentTurnCalls()
    if (calls === null || this.asking || this.disposed) {
      return
    }
    const at = this.now()
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.lane.apply(this.lane.translator.endAgentTurn(at))
      },
      calls.running ? CALL_QUIET_MS : QUIET_MS
    )
  }

  /** Whether the agent is waiting on a request the person has not answered. */
  awaitRequests(open: boolean): void {
    this.asking = open
    this.restart()
  }

  /** Returns whether an agent turn ended. */
  end(stopReason?: string): boolean {
    const events = this.lane.translator.endAgentTurn(this.now(), stopReason)
    if (events.length > 0) {
      this.lane.apply(events)
    }
    return events.length > 0
  }

  /** Unprompted work asking nothing ends without a cancel; its running calls continue as
   *  background tasks. Returns whether that ended the agent turn. */
  endUnasked(): boolean {
    return !this.asking && this.end()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
