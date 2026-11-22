import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { DISPATCH_DOUBT_PROVIDER_IDLE } from '../../../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import {
  rejectClaudeDispatchWaiters,
  releaseClaudeDispatchWaitersInDoubt
} from '../dispatch/claude-structured-dispatch'
import type { ClaudeDispatchWaiter, ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import { isRootClaudeFrame } from './claude-turn-opening'

/**
 * Idle followed by silence has no event of its own, so only a timer can end it. Claude answers a
 * send taken while idle with `running`, `queued` and `started` in one burst (2.1.280 captures), and
 * "idle can precede queued work starting" only for that burst: across 4,918 sends Orca wrote after a
 * turn ended (952 local Claude transcripts), every one left Claude's queue within 0.72 s (p99.9
 * 0.11 s). 30 s is 40x the slowest, matches Claude's control-request deadline, and keeps a stalled
 * send from holding a chat's mail for long.
 */
export const CLAUDE_UNSTARTED_SEND_GRACE_MS = 30_000

const defaultLogger = createStructuredAgentSessionLogger()

/** A send Claude accepted while idle but never started is withdrawn and resent once, else released. */
export class ClaudeUnstartedSendWatch {
  private timer: ReturnType<typeof setTimeout> | undefined
  private idle = false
  /** Content withdrawn since Claude last started work; a second stall of it is released, not resent. */
  private readonly withdrawn = new Set<string>()

  constructor(
    private readonly deps: {
      sessionId: string
      session: ClaudeSession
      isCurrent: () => boolean
      settle: ClaudeLateDispatchSettlement
      timeoutMs?: number
      logger?: StructuredAgentSessionLogger
    }
  ) {}

  /** Every root frame is activity: it restarts the grace, which runs only while Claude says idle. */
  observe(message: Record<string, unknown>): void {
    if (!isRootClaudeFrame(message)) {
      return
    }
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.idle = message.state === 'idle'
    }
    if (
      message.type === 'assistant' ||
      (message.type === 'command_lifecycle' && message.state === 'started')
    ) {
      this.withdrawn.clear()
    }
    this.rearm()
  }

  /** A send written while Claude is idle starts the grace if nothing else will. */
  admitted(): void {
    if (this.timer === undefined) {
      this.rearm()
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private rearm(): void {
    this.dispose()
    if (this.idle && this.unstarted().length > 0) {
      this.timer = setTimeout(() => void this.fire(), CLAUDE_UNSTARTED_SEND_GRACE_MS)
      this.timer.unref?.()
    }
  }

  private unstarted(): ClaudeDispatchWaiter[] {
    return this.deps.session.dispatchWaiters.filter(
      (waiter) => waiter.clientMessageId !== null && waiter.commandLifecycle !== 'started'
    )
  }

  private live(): boolean {
    return this.deps.isCurrent() && !this.deps.session.connection.closed
  }

  private async fire(): Promise<void> {
    this.timer = undefined
    const { session, settle, timeoutMs } = this.deps
    for (const waiter of this.unstarted()) {
      if (!this.live() || !this.idle) {
        return
      }
      const resent = this.withdrawn.has(waiter.replayContentKey)
      const withdrawn =
        !resent &&
        (await session.connection
          .cancelAsyncMessage(waiter.sentUuid, { timeoutMs })
          .catch(() => false))
      // Its own lifecycle frame may have settled it while the withdrawal was in flight.
      if (!this.live() || !session.dispatchWaiters.includes(waiter)) {
        continue
      }
      neverThrowingStructuredAgentSessionLogger(this.deps.logger ?? defaultLogger).warn(
        'Claude went idle without starting a send',
        {
          scope: 'claude-unstarted-send',
          sessionId: this.deps.sessionId,
          clientMessageId: waiter.clientMessageId,
          outcome: withdrawn ? 'withdrawn' : 'released'
        }
      )
      if (withdrawn) {
        this.withdrawn.add(waiter.replayContentKey)
        // Proven unrun: a queued card waits again and delivery resends it.
        rejectClaudeDispatchWaiters(
          session,
          [waiter.sentUuid],
          agentSessionFailureFact('notDelivered'),
          settle
        )
      } else {
        releaseClaudeDispatchWaitersInDoubt(session, [waiter], DISPATCH_DOUBT_PROVIDER_IDLE, settle)
      }
    }
  }
}
