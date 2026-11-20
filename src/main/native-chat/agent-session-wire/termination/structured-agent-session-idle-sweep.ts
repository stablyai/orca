// Derive owed work each tick, independent of viewers; retire quiet children and cached folds,
// preserving durable conversations for the next send.

import { DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { AgentSessionIdleConfirmation } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionCurrentWorkHost } from '../observations/structured-agent-session-host-current-work'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import type { JournalWorkAnswer } from '../../agent-session-journal/journal-work-read'

type RunningChild = NonNullable<StructuredAgentSessionHostSession['child']>

/** What an early release saw: stopped (or nothing loaded), owed or running work, or no proof either way. */
export type StructuredAgentSessionReleaseObservation = 'released' | 'busy' | 'unconfirmed'
type Observe = (seen: StructuredAgentSessionReleaseObservation) => void

export const STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS = 5 * 60_000
export const STRUCTURED_AGENT_SESSION_IDLE_MS = DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES * 60_000

export type StructuredAgentSessionIdleSweepDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    lastActivityAt: (sessionId: string) => number | undefined
    touch: (sessionId: string) => void
  }
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  isDisposed: () => boolean
  deliveryActive: (sessionId: string) => boolean
  /** Includes provider work not yet recorded. */
  childWorkOpen: (sessionId: string) => boolean
  hasOpenDispatch: (sessionId: string) => boolean
  /** Provider-retained, unanswered sends. */
  providerHoldsDispatch: (sessionId: string) => boolean
  /** Provider-declared background work, asked fresh before a running child's idle stop. */
  confirmIdle: (sessionId: string) => Promise<AgentSessionIdleConfirmation> | undefined
  store: StructuredAgentSessionCurrentWorkHost['store']
  /** Already inside nonreentrant session serialization. */
  stopAgent: (sessionId: string) => Promise<void>
  stopStartingAgent: (sessionId: string) => Promise<void>
  /** Whether the start's own deadline, which runs on awake time, still times this child. */
  startTimed: (sessionId: string, child: RunningChild) => boolean
  closeConversation: (sessionId: string) => Promise<boolean>
  logger: StructuredAgentSessionLogger
  intervalMs?: number
  /** Read every tick so a settings change applies without a restart; null never stops a chat. */
  idleMs?: () => number | null
  /** A client is subscribed to the chat; an early release leaves it to the window. */
  viewed?: (sessionId: string) => boolean
}

export type StructuredAgentSessionChildWorkReads = {
  /** Ended-generation turns/prompts cannot retain children; null means no held conversation. */
  currentWork: () => Promise<JournalWorkAnswer<'child-work'> | null>
  /** Provider evidence; bounded stores may have refused a record. */
  childWorkOpen: () => boolean
  hasOpenDispatch: () => boolean
  providerHoldsDispatch: () => boolean
}

/** Check turn, child, dispatch, held-send and prompt work without building a snapshot. */
export function structuredAgentSessionChildHasOpenWork(
  reads: Omit<StructuredAgentSessionChildWorkReads, 'currentWork'>,
  work: JournalWorkAnswer<'child-work'> | null
): boolean {
  return (
    work?.activeTurn === true ||
    reads.childWorkOpen() ||
    reads.hasOpenDispatch() ||
    reads.providerHoldsDispatch() ||
    work?.actionablePrompt === true
  )
}

export class StructuredAgentSessionIdleSweep {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: StructuredAgentSessionIdleSweepDeps) {}

  start(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS
    )
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run sessions concurrently; skip overlapping ticks so one locked start cannot delay others. */
  async tick(): Promise<void> {
    if (this.running || this.deps.isDisposed()) {
      return
    }
    this.running = true
    try {
      const agentIdleMs = this.idleWindow()
      await Promise.allSettled(
        [...this.deps.sessions.keys()].map((sessionId) =>
          this.sweepSession(sessionId, agentIdleMs).catch((error: unknown) =>
            this.deps.logger.warn('an idle sweep step failed', {
              scope: 'idle-sweep',
              sessionId,
              error
            })
          )
        )
      )
    } finally {
      this.running = false
    }
  }

  /** Stop now what a sweep past the window would, for a finished run nobody watches; Never keeps
   *  it. `anyway` also stops a viewed or Never chat's idle agent, e.g. after an account switch. */
  async release(
    sessionId: string,
    anyway = false
  ): Promise<StructuredAgentSessionReleaseObservation> {
    const window = (): 0 | null => (anyway ? 0 : this.releaseWindow(sessionId))
    let seen: StructuredAgentSessionReleaseObservation = 'unconfirmed'
    if (!this.deps.isDisposed() && window() === 0) {
      await this.sweepSession(sessionId, 0, window, (next) => {
        seen = next
      })
    }
    return seen
  }

  private idleWindow(): number | null {
    return this.deps.idleMs ? this.deps.idleMs() : STRUCTURED_AGENT_SESSION_IDLE_MS
  }

  private releaseWindow(sessionId: string): 0 | null {
    return this.idleWindow() === null || this.deps.viewed?.(sessionId) ? null : 0
  }

  /** Ask outside serialization so a slow provider never delays user actions; recheck before stopping. */
  private async sweepSession(
    sessionId: string,
    agentIdleMs: number | null,
    release?: () => 0 | null,
    observe?: Observe
  ): Promise<void> {
    const unconfirmed = await this.deps.serialize(sessionId, () =>
      this.tickUnderSerialize(
        sessionId,
        release ? release() : agentIdleMs,
        null,
        !!release,
        observe
      )
    )
    if (!unconfirmed) {
      return
    }
    const answer = (await this.deps.confirmIdle(sessionId)) ?? 'idle'
    if (answer === 'unknown') {
      observe?.('unconfirmed')
      return
    }
    await this.deps.serialize(sessionId, async () => {
      if (answer === 'idle') {
        // The answer can take seconds; a window changed meanwhile (to Never, say) still applies.
        const still = await this.tickUnderSerialize(
          sessionId,
          release ? release() : this.idleWindow(),
          unconfirmed,
          !!release,
          observe
        )
        if (still) {
          observe?.('unconfirmed')
        }
      } else {
        observe?.('busy')
        if (this.deps.sessions.get(sessionId)?.child === unconfirmed) {
          this.deps.sessions.touch(sessionId)
        }
      }
    })
  }

  /** Recheck under serialization to include queued acceptance; a running child must be confirmed idle. */
  private async tickUnderSerialize(
    sessionId: string,
    agentIdleMs: number | null,
    confirmed: RunningChild | null,
    releasing = false,
    observe?: Observe
  ): Promise<RunningChild | null> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.deps.isDisposed()) {
      observe?.(session ? 'unconfirmed' : 'released')
      return null
    }
    // Wall-clock idle counts sleep, so it never ends a start its own deadline still times.
    if (session.child?.phase === 'starting' && this.deps.startTimed(sessionId, session.child)) {
      observe?.('busy')
      return null
    }
    // Renew owed work every tick to allow a full window for the lead’s post-child wake-up.
    if (
      session.child &&
      session.child.phase !== 'starting' &&
      (await this.owesWork(sessionId, session))
    ) {
      observe?.('busy')
      this.deps.sessions.touch(sessionId)
      return null
    }
    // Never only keeps agents running; a handle with no agent still retires on the default window.
    const idleMs = agentIdleMs ?? (session.child ? null : STRUCTURED_AGENT_SESSION_IDLE_MS)
    if (idleMs === null) {
      return null
    }
    const lastActivityAt = this.deps.sessions.lastActivityAt(sessionId) ?? this.deps.now()
    if (this.deps.now() - lastActivityAt < idleMs) {
      return null
    }
    if (session.child) {
      if (session.child.phase === 'starting') {
        // A start after the run ended is someone's new send.
        if (releasing) {
          observe?.('busy')
          return null
        }
        await this.deps.stopStartingAgent(sessionId)
        return null
      }
      if (session.child !== confirmed) {
        return session.child
      }
      await this.deps.stopAgent(sessionId)
    }
    observe?.((await this.deps.closeConversation(sessionId)) ? 'released' : 'unconfirmed')
    return null
  }

  private async queuedOrDelivering(sessionId: string, session: StructuredAgentSessionHostSession) {
    return (
      this.deps.deliveryActive(sessionId) ||
      (await session.journal.reads.input({ kind: 'recoverable-submissions' })).submissions.some(
        isQueuedAgentJournalSubmission
      )
    )
  }

  /** Without a child, leftover turns/prompts are history and cannot retain the handle. */
  private async owesWork(
    sessionId: string,
    session: StructuredAgentSessionHostSession
  ): Promise<boolean> {
    return (
      (await this.queuedOrDelivering(sessionId, session)) ||
      structuredAgentSessionChildHasOpenWork(
        {
          childWorkOpen: () => this.deps.childWorkOpen(sessionId),
          hasOpenDispatch: () => this.deps.hasOpenDispatch(sessionId),
          providerHoldsDispatch: () => this.deps.providerHoldsDispatch(sessionId)
        },
        await readHostStructuredAgentSessionWork(this.deps, sessionId, { kind: 'child-work' })
      )
    )
  }
}
