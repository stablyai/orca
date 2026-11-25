import { randomUUID } from 'node:crypto'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import type { AcpToolTimeline } from './acp-tool-timeline'

// Frames that trail a Stop are the stopped work's, not new work.
const STOP_GRACE_MS = 5_000

/** Work the agent resumes unprompted gets its own turn; nothing from the agent ends it. */
export class AcpAgentTurns {
  private open?: string
  private stoppedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly dialect: AcpDialect,
    private readonly tools: AcpToolTimeline,
    private readonly backgroundTasks: AcpBackgroundTaskTimeline
  ) {}

  /** A new turn for substantive frames arriving while none is open; a backgrounded call's
   *  own report updates its task in place. */
  mint(opens: boolean, at: number, update?: SessionUpdate): string | undefined {
    if (
      !opens ||
      !this.dialect.reactiveWakeups ||
      at < this.stoppedAt + STOP_GRACE_MS ||
      // Trailing status of a call whose turn already ended starts no work.
      (update?.sessionUpdate === 'tool_call_update' && this.tools.ended(update.toolCallId))
    ) {
      return undefined
    }
    this.open = `agent:${randomUUID()}`
    return this.open
  }

  /** Releases the agent turn if it is the active one; a Stop holds off new ones briefly. */
  take(active: string | undefined, at: number, stopReason: string): string | undefined {
    if (stopReason === 'cancelled') {
      this.stoppedAt = at
    }
    const open = this.open
    this.open = undefined
    return open !== undefined && open === active ? open : undefined
  }

  /** A new send supersedes the Stop grace. */
  resume(): void {
    this.stoppedAt = Number.NEGATIVE_INFINITY
  }

  /** The active agent turn's running calls; null when no agent turn is active. */
  calls(active: string | undefined): string[] | null {
    return this.open === undefined || this.open !== active ? null : this.tools.runningIds(this.open)
  }

  /** A normal end with calls still running means the agent backgrounded them; after Orca's own
   *  cancel they were stopped, not backgrounded. */
  background(turn: string, ending: AcpTurnEnding, thread: string): ProviderTimelineEvent[] {
    if (
      !this.dialect.reactiveWakeups ||
      ending.stopReason !== 'end_turn' ||
      ending.cancelRequested
    ) {
      return []
    }
    const join = { thread, turn }
    const { events, tasks } = this.tools.background(turn, join)
    return [...events, ...this.backgroundTasks.translate(tasks, join)]
  }
}
