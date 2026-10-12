// The host's one retry of background bookkeeping on its database connection: what ended
// generations and an earlier host process left, and queue sends that met another connection's lock.
// One owed set (`signal`; a reader's open puts an owed chat first). A round runs (a) the store-wide
// step while owed (`reconcileOwed`), then per owed chat, one at a time in its lane, (b) release
// repair, (c) settlement (`runStructuredAgentSessionReconciliationPass`), (d) the queue's next send.
// Every write is background: a lock fails it at once and stops the round.
// One wake (`wake`): marking a chat owed or any commit runs a round now unless one runs or the timer
// waits; a commit after a lock refused the last round ends that wait. The timer is the backoff
// after a refused round (1 s to 2 s), or its first step after a busy lane. One budget: about 3
// minutes since the episode's first refused round give up (`RECONCILIATION_GIVE_UP_MS`), keeping
// the set, dropping its loaded reads and showing owed sends as not sent; only a round that made
// progress ends the episode, and only the next wake after a give-up resets it.

import type { AgentSessionGenerationEnd } from '../../runtime/agent-session-generation-end'
import { setImmediate as yieldToEvents } from 'node:timers/promises'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionExitSettlement } from './structured-agent-session-leftover-settlement'
import {
  RECONCILIATION_GIVE_UP_MS,
  reconciliationBackoffDelay
} from './structured-agent-session-reconciliation-backoff'
import { StructuredAgentSessionReconciliationSlots } from './structured-agent-session-reconciliation-slots'
import { providerChildExitSettling } from './structured-agent-session-provider-child'
import {
  dropStructuredAgentSessionLoaded,
  noteStructuredAgentSessionOpened,
  visitStructuredAgentSessionOwedChat,
  type StructuredAgentSessionOwedChat as OwedChat,
  type StructuredAgentSessionRetryContext,
  type StructuredAgentSessionVisit as Visit,
  type StructuredAgentSessionVisitHost
} from './structured-agent-session-reconciliation-visit'

export type { StructuredAgentSessionRetryContext } from './structured-agent-session-reconciliation-visit'

export type StructuredAgentSessionReconciliationSignal = {
  /** Proof the lease no longer holds (`AgentSessionGenerationEnd.evidence`). */
  evidence?: AgentSessionGenerationEnd['evidence']
  /** An observed exit whose own settlement did not land. */
  exit?: StructuredAgentSessionExitSettlement
  /** Readers re-baseline at the moved fence (`publishGenerationEnded`). */
  restate?: boolean
  /** The exit's own writes, or the queue's send, met another connection's lock. */
  contended?: boolean
}

export class StructuredAgentSessionRetry {
  private readonly owed = new Map<string, OwedChat>()
  /** Where this process first opened each chat's journal: every send at or before it was accepted
   *  by an earlier process. Kept for the whole process; dropped only with the chat's record. */
  private readonly firstOpened = new Map<string, AgentJournalCursor>()
  private readonly slots = new StructuredAgentSessionReconciliationSlots(() => this.disposed)
  private readonly unsubscribe: () => void
  /** The one timer ('soon': a round queued now). */
  private timer: ReturnType<typeof setTimeout> | 'soon' | null = null
  private running = false
  /** Woken while a round ran: another follows at once. */
  private again = false
  /** Refused rounds in a row, and when the first was (`performance.now()`); at the budget the
   *  episode ends. `locked`: the last one met another connection's lock, which a commit here proves
   *  gone. */
  private failures = 0
  private failingSince: number | null = null
  private locked = false
  private disposed = false
  /** The round's chain of chat turns (`inTurn`), and whether contention stopped the round. */
  private turn: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly visitHost: StructuredAgentSessionVisitHost

  constructor(private readonly context: StructuredAgentSessionRetryContext) {
    this.visitHost = {
      context,
      disposed: () => this.disposed,
      firstOpened: this.firstOpened,
      settle: (sessionId, chat) => this.settle(sessionId, chat),
      warn: (sessionId, error) => this.warn(sessionId, error),
      inTurn: (run) => this.inTurn(run)
    }
    this.unsubscribe = context.deps.store.onGenerationEnded((ended) =>
      this.signal(ended.sessionId, { evidence: ended.evidence })
    )
  }

  signal = (sessionId: string, signal: StructuredAgentSessionReconciliationSignal = {}): void => {
    const session = this.context.sessions.get(sessionId)
    if (session) {
      session.operationalRevision = (session.operationalRevision ?? 0) + 1
    }
    const chat = this.disposed ? null : this.owe(sessionId)
    if (chat && signal.evidence) {
      chat.debts.evidence = [...(chat.debts.evidence ?? []), signal.evidence]
    }
    if (chat && signal.exit) {
      chat.debts.exit = signal.exit
    }
    if (chat && signal.contended) {
      // Its queued send met, or would meet, the same lock: the round sends it.
      chat.send = true
    }
    this.context.publishGenerationEnded(sessionId, signal.restate ? { restate: true } : {})
    this.wake()
  }

  /** A committed row: one below the lease's fence is an ended generation's late write; any one
   *  wakes the retry. */
  observeCommit = (sessionId: string, lowestFence: number | null): void => {
    const fence = this.context.deps.store.getRecord(sessionId)?.lease.runtimeFence
    if (lowestFence !== null && fence !== undefined && lowestFence < fence) {
      this.signal(sessionId)
    } else if ([...this.owed.values()].some((chat) => chat.due)) {
      this.wake(this.locked)
    }
  }

  /** A reader opened the chat: its handle marks the process boundary if it is the first, and an
   *  owed chat goes ahead of the scan. */
  opened = (sessionId: string, journal: Pick<AgentSessionJournal, 'openedAt'>): void => {
    noteStructuredAgentSessionOpened(this.firstOpened, sessionId, journal)
    const chat = this.owed.get(sessionId)
    if (chat) {
      this.slots.prioritize(chat)
      this.wake()
    }
  }

  /** Whether the chat's queued send waits for a round (or for a fresh episode, given up): it met a
   *  lock, or the exit it follows is still settling. */
  sendWaits = (sessionId: string): boolean =>
    this.owed.get(sessionId)?.send === true ||
    providerChildExitSettling(this.context.sessions.get(sessionId))

  /** Resolves once the chat's next visit finished, or at once when it owes nothing. */
  attempted = (sessionId: string): Promise<void> => {
    const chat = this.owed.get(sessionId)
    return chat?.due ? new Promise((resolve) => chat.attempted.push(resolve)) : Promise.resolve()
  }

  /** Shutdown: the timer stops and every slot wait ends; a visit already writing finishes,
   *  tracked, and one that has not started work starts none. */
  dispose = (): void => {
    this.disposed = true
    this.unsubscribe()
    this.stopTimer()
    for (const [sessionId, chat] of this.owed) {
      chat.slotWait?.abort()
      this.settle(sessionId, chat)
    }
  }

  private owe(sessionId: string): OwedChat {
    let chat = this.owed.get(sessionId)
    if (!chat) {
      chat = { debts: {}, due: true, dirty: false, attempted: [], urgent: false }
      this.owed.set(sessionId, chat)
    }
    chat.due = true
    chat.dirty = true
    return chat
  }

  /** The one wake: a round now, unless one runs (it runs again) or the timer is pending, which
   *  `early` (a commit after a lock refused the last round) ends. After a give-up it starts a fresh
   *  episode, the budget's only reset. */
  private wake(early = false): void {
    if (this.disposed) {
      return
    }
    if (this.running) {
      this.again = true
      return
    }
    // No backoff pending once the budget is spent: the episode gave up, and this wake starts anew.
    if (this.timer === null && this.failingFor() >= RECONCILIATION_GIVE_UP_MS) {
      this.failures = 0
      this.failingSince = null
    }
    if (early) {
      this.stopTimer()
    }
    if (this.timer !== null) {
      return
    }
    this.timer = 'soon'
    queueMicrotask(() => void this.round())
  }

  private async round(): Promise<void> {
    this.timer = null
    if (this.disposed || this.running) {
      return
    }
    this.running = true
    this.again = false
    this.stopped = false
    let failed = false
    let locked = false
    let busy = false
    let progress = false
    const end = (visit: Visit) => {
      progress ||= visit === 'settled' || visit === 'again'
      failed ||= visit === 'failed' || visit === 'contended'
      locked ||= visit === 'contended'
      busy ||= visit === 'busy'
      this.stopped ||= visit === 'contended'
      this.again ||= visit === 'again'
    }
    if (this.context.reconcileOwed()) {
      // Store-wide: once a round, for every chat, never once per chat. No chat is visited while it
      // owes anything.
      const reconciled = await this.context.reconcile()
      end(reconciled)
      this.stopped = reconciled !== 'settled'
    }
    const due = [...this.owed].filter(([, chat]) => chat.due)
    // Nothing owed is progress too; a round only busy or parked is not.
    progress ||= due.length === 0
    await Promise.all(
      due.map(async ([sessionId, chat]) => {
        const visit = this.stopped ? null : await this.visitInSlot(sessionId, chat)
        if (visit) {
          end(visit)
        }
      })
    )
    this.running = false
    this.roundEnded(failed, locked, busy, progress)
    // After the round's outcome is set, so a waiter reads its backoff, never a round still running.
    for (const [, chat] of due) {
      chat.attempted.splice(0).forEach((resolve) => resolve())
    }
  }

  private roundEnded(failed: boolean, locked: boolean, busy: boolean, progress: boolean): void {
    if (this.disposed) {
      return
    }
    this.locked = locked
    if (!failed) {
      if (progress) {
        this.failures = 0
        this.failingSince = null
      }
      if (this.again) {
        this.wake()
      } else if (busy) {
        // A person's operation held a lane: its chat waits the timer's first step, not a budget.
        this.arm(reconciliationBackoffDelay(1))
      }
      return
    }
    this.failures += 1
    this.failingSince ??= performance.now()
    if (this.failingFor() < RECONCILIATION_GIVE_UP_MS) {
      this.arm(reconciliationBackoffDelay(this.failures))
      return
    }
    // The episode ends; the set stays for the next wake.
    this.context.deps.logger.warn("gave up settling a gone agent's leftover work for now", {
      scope: 'reconciliation',
      error: new Error(`${this.failures} rounds failed`)
    })
    for (const [sessionId, chat] of this.owed) {
      // Owed still, but no hidden chat's replay is held through the wait for the next wake.
      dropStructuredAgentSessionLoaded(chat)
      if (chat.send) {
        this.context.abandonSend(sessionId)
      }
    }
  }

  private failingFor(): number {
    return this.failingSince === null ? 0 : performance.now() - this.failingSince
  }

  private arm(delay: number): void {
    this.stopTimer()
    const timer = setTimeout(() => void this.round(), delay)
    // A backoff alone never keeps the process alive.
    timer.unref?.()
    this.timer = timer
  }

  /** An open chat, or one already loaded, goes straight to its lane; a closed one is replayed in a
   *  background slot, never once the round stopped. */
  private async visitInSlot(sessionId: string, chat: OwedChat): Promise<Visit | null> {
    if (this.context.sessions.has(sessionId) || chat.loaded) {
      return this.context.track(this.visit(sessionId, chat))
    }
    // The replay yields a macrotask first (`loadStructuredAgentSessionForReconciliation`).
    const result = await this.slots.run(chat, async () =>
      this.disposed || this.stopped ? null : this.context.track(this.visit(sessionId, chat))
    )
    return result?.value ?? null
  }

  private visit(sessionId: string, chat: OwedChat): Promise<Visit | null> {
    return visitStructuredAgentSessionOwedChat(this.visitHost, sessionId, chat)
  }

  /** Chats load in the slots side by side, but write one at a time, in the order they are ready (a
   *  reader's open chat first), yielding between chats: each visit's writes stay bounded, and a
   *  person's operation queued meanwhile runs before the next chat's turn takes its lane. */
  private inTurn<T>(run: () => Promise<T>): Promise<T | null> {
    const next = this.turn.then(() => (this.stopped || this.disposed ? null : run()))
    this.turn = next.then(
      () => yieldToEvents(),
      () => yieldToEvents()
    )
    return next
  }

  private settle(sessionId: string, chat: OwedChat): 'settled' {
    if (this.owed.get(sessionId) === chat) {
      this.owed.delete(sessionId)
    }
    dropStructuredAgentSessionLoaded(chat)
    chat.attempted.splice(0).forEach((resolve) => resolve())
    return 'settled'
  }

  private stopTimer(): void {
    if (this.timer && this.timer !== 'soon') {
      clearTimeout(this.timer)
    }
    if (this.timer !== 'soon') {
      this.timer = null
    }
  }

  private warn(sessionId: string, error: unknown): void {
    this.context.deps.logger.warn("settling a gone agent's leftover work did not finish", {
      scope: 'reconciliation',
      sessionId,
      error
    })
  }
}
