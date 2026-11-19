import { randomUUID } from 'node:crypto'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import type { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import type { AcpToolTimeline } from './acp-tool-timeline'

const QUIET_MS = 10_000
// Running calls may be waiting on a person or a slow command.
const CALL_QUIET_MS = 120_000

/** Work the agent resumes unprompted gets its own turn; nothing from the agent ends it. */
export class AcpAgentTurns {
  private open?: string

  constructor(
    private readonly dialect: AcpDialect,
    private readonly tools: AcpToolTimeline,
    private readonly backgroundTasks: AcpBackgroundTaskTimeline
  ) {}

  /** A new turn for substantive frames arriving while none is open; a backgrounded call's
   *  own report updates its task in place. */
  mint(opens: boolean, update?: SessionUpdate): string | undefined {
    if (
      !opens ||
      !this.dialect.reactiveWakeups ||
      // Trailing status of a call whose turn already ended starts no work.
      (update?.sessionUpdate === 'tool_call_update' &&
        (this.tools.backgrounds(update.toolCallId) || this.tools.turn(update.toolCallId)))
    ) {
      return undefined
    }
    this.open = `agent:${randomUUID()}`
    return this.open
  }

  /** Releases the agent turn if it is the active one. */
  take(active: string | undefined): string | undefined {
    const open = this.open
    this.open = undefined
    return open !== undefined && open === active ? open : undefined
  }

  /** Null when no agent turn is active or a call in it awaits approval. */
  quietMs(active: string | undefined): number | null {
    if (this.open === undefined || this.open !== active) {
      return null
    }
    const calls = this.tools.running(this.open)
    return calls === 'pending' ? null : calls ? CALL_QUIET_MS : QUIET_MS
  }

  /** A normal end with calls still running means the agent backgrounded them. */
  background(turn: string, ending: AcpTurnEnding, thread: string): ProviderTimelineEvent[] {
    if (!this.dialect.reactiveWakeups || ending.stopReason !== 'end_turn') {
      return []
    }
    const join = { thread, turn }
    const { events, tasks } = this.tools.background(turn, join)
    return [...events, ...this.backgroundTasks.translate(tasks, join)]
  }
}
