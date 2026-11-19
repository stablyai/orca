import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'

type AcpAgentTurnLane = {
  readonly translator: AcpTimelineTranslator
  apply(events: readonly ProviderTimelineEvent[]): void
}

/** Unprompted agent work has no end of its own; quiet, Stop or the next send ends it. */
export class AcpAgentTurnQuiet {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly lane: AcpAgentTurnLane,
    private readonly now: () => number
  ) {}

  /** Lane activity restarts the quiet period while an agent turn is open. */
  restart(): void {
    this.stop()
    const quietMs = this.lane.translator.agentTurnQuietMs()
    if (quietMs === null) {
      return
    }
    const at = this.now()
    this.timer = setTimeout(() => {
      this.timer = null
      this.lane.apply(this.lane.translator.endAgentTurn(at))
    }, quietMs)
  }

  end(stopReason?: string): void {
    const events = this.lane.translator.endAgentTurn(this.now(), stopReason)
    if (events.length > 0) {
      this.lane.apply(events)
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
