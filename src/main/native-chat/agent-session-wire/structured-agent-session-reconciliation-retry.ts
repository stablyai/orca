// The host's one retry of background bookkeeping, scoped to its database connection: what ended
// generations left, what an earlier host process left, and the queue's automatic sends that met
// another connection's lock. One set of owed chats, one round at a time, one timer and one budget.
//
// Signals: every committed revocation or supersession of a generation (the record store's
// `onGenerationEnded`), an exit this host observed (whether or not its release landed), a row an
// ended generation committed late, a queue send that met contention, and startup. Each one
// re-derives what readers see at once (the operational revision, the published view, the queued-
// card drain) and marks the chat owed. A round visits every owed chat: closed ones load side by
// side in the few background slots, a reader's first, and each writes in its turn, one chat at a
// time with a yield between (`inTurn`):
// (a) the store-wide restart reconcile, once, while any lease is unreconciled; then per chat, in
// its lane, (b) release repair, (c) settlement and what an earlier
// process left (`runStructuredAgentSessionReconciliationPass`), (d) the queue's next send. Every
// write is background (`JournalWriteOptions`): another connection's lock fails it at once and ends
// the round, since contention is connection-wide.
//
// A failed round backs off from 1 s to 30 s; ten in a row end the episode: the timer stops, the set
// is kept, and a queue send still owed shows as not sent (`abandonSend`). A new signal, a reader's
// open, or a commit on the connection after contention starts a fresh episode. A lease latched in
// recovery is never decided here: its proofs wait in the set for its decision's signal.

import type { AgentSessionGenerationEnd } from '../../runtime/agent-session-generation-end'
import { setImmediate as yieldToEvents } from 'node:timers/promises'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionExitSettlement } from './structured-agent-session-leftover-settlement'
import {
  RECONCILIATION_MAX_FAILED_ATTEMPTS,
  reconciliationBackoffDelay
} from './structured-agent-session-reconciliation-backoff'
import { StructuredAgentSessionReconciliationSlots } from './structured-agent-session-reconciliation-slots'
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
}

const BACKGROUND = { background: true } as const

export class StructuredAgentSessionRetry {
  private readonly owed = new Map<string, OwedChat>()
  /** Where this process first opened each chat's journal: every send at or before it was accepted
   *  by an earlier process. Kept for the whole process; dropped only with the chat's record. */
  private readonly firstOpened = new Map<string, AgentJournalCursor>()
  private readonly slots = new StructuredAgentSessionReconciliationSlots(() => this.disposed)
  private readonly unsubscribe: () => void
  private timer: ReturnType<typeof setTimeout> | 'soon' | null = null
  private running = false
  /** A chat became due while a round ran: another follows at once. */
  private again = false
  /** Consecutive failed rounds in this episode; at the budget the episode ends. */
  private failures = 0
  /** The last round failed on another connection's lock, which a commit here proves gone. */
  private contended = false
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
    this.context.publishGenerationEnded(sessionId, signal.restate ? { restate: true } : {})
    this.freshEpisode()
  }

  /** A committed row: one below the lease's fence is an ended generation's late write, and any
   *  commit proves the connection free again after contention. */
  observeCommit = (sessionId: string, lowestFence: number | null): void => {
    const fence = this.context.deps.store.getRecord(sessionId)?.lease.runtimeFence
    if (lowestFence !== null && fence !== undefined && lowestFence < fence) {
      this.signal(sessionId)
    } else if (this.contended) {
      this.freshEpisode()
    }
  }

  /** A reader opened the chat: its handle marks the process boundary if it is the first, and what
   *  it owes goes ahead of the scan, in a fresh episode. */
  opened = (sessionId: string, journal: Pick<AgentSessionJournal, 'openedAt'>): void => {
    noteStructuredAgentSessionOpened(this.firstOpened, sessionId, journal)
    const chat = this.owed.get(sessionId)
    if (chat) {
      this.slots.prioritize(chat)
      this.freshEpisode()
    }
  }

  /** The queue's automatic send met another connection's lock: the next round sends it again. */
  sendContended = (sessionId: string): void => {
    if (!this.disposed) {
      this.owe(sessionId).send = true
      this.context.publishGenerationEnded(sessionId)
      this.roundEnded(true, true)
    }
  }

  /** Whether the chat's queued send waits for a round (or for a fresh episode, given up). */
  sendWaits = (sessionId: string): boolean => this.owed.get(sessionId)?.send === true

  /** Resolves once the chat's next visit finished, or at once when it owes nothing. */
  attempted = (sessionId: string): Promise<void> => {
    const chat = this.owed.get(sessionId)
    return chat?.due ? new Promise((resolve) => chat.attempted.push(resolve)) : Promise.resolve()
  }

  /** Whether a visit is owed: something was signalled, or failed, and has not settled. */
  owes = (sessionId: string): boolean => this.owed.get(sessionId)?.due === true

  /** Resolves once the chat owes nothing, or waits out a failed round's backoff. */
  idle = async (sessionId: string): Promise<void> => {
    while (this.owes(sessionId) && (this.running || this.timer === 'soon' || this.failures === 0)) {
      await this.attempted(sessionId)
    }
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

  processOpened(sessionId: string): AgentJournalCursor | undefined {
    return this.firstOpened.get(sessionId)
  }

  private owe(sessionId: string): OwedChat {
    let chat = this.owed.get(sessionId)
    if (!chat) {
      chat = { debts: {}, due: true, dirty: false, attempted: [], urgent: false }
      this.owed.set(sessionId, chat)
    }
    chat.due = true
    chat.dirty = true
    this.again ||= this.running
    return chat
  }

  /** A new reason to try: the budget resets and a round runs now. */
  private freshEpisode(): void {
    if (this.disposed) {
      return
    }
    this.failures = 0
    this.contended = false
    if (!this.running && this.timer !== 'soon') {
      this.stopTimer()
      this.timer = 'soon'
      queueMicrotask(() => void this.round())
    }
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
    const end = (visit: Visit) => {
      failed ||= visit === 'failed' || visit === 'contended'
      this.stopped ||= visit === 'contended'
      this.again ||= visit === 'again'
    }
    if (this.context.deps.store.listRecords().some((record) => record.lease.unreconciled)) {
      // Store-wide: once a round, for every chat, never once per chat.
      if (!(await this.context.reconcile('retry', BACKGROUND))) {
        end('contended')
      }
    }
    const due = [...this.owed].filter(([, chat]) => chat.due)
    await Promise.all(
      due.map(async ([sessionId, chat]) => {
        const visit = this.stopped ? null : await this.visitInSlot(sessionId, chat)
        if (visit) {
          end(visit)
        }
      })
    )
    this.running = false
    this.roundEnded(failed, this.stopped)
    // After the round's outcome is set, so a waiter reads its backoff, never a round still running.
    for (const [, chat] of due) {
      chat.attempted.splice(0).forEach((resolve) => resolve())
    }
  }

  private roundEnded(failed: boolean, contended: boolean): void {
    if (this.disposed || this.running) {
      return
    }
    if (!failed) {
      this.failures = 0
      this.contended = false
      if (this.again && this.timer === null) {
        this.freshEpisode()
      }
      return
    }
    this.failures += 1
    this.contended = contended
    this.stopTimer()
    if (this.failures < RECONCILIATION_MAX_FAILED_ATTEMPTS) {
      const timer = setTimeout(() => void this.round(), reconciliationBackoffDelay(this.failures))
      // A backoff alone never keeps the process alive.
      timer.unref?.()
      this.timer = timer
      return
    }
    // The episode ends; the set stays for the next signal, open or commit.
    this.context.deps.logger.warn("gave up settling a gone agent's leftover work for now", {
      scope: 'reconciliation',
      error: new Error(`${this.failures} rounds failed`)
    })
    for (const [sessionId, chat] of this.owed) {
      if (chat.send) {
        this.context.abandonSend(sessionId)
      }
    }
  }

  /** An open chat goes straight to its lane; a closed one is replayed in a background slot. */
  private async visitInSlot(sessionId: string, chat: OwedChat): Promise<Visit | null> {
    if (this.context.sessions.has(sessionId) || chat.loaded) {
      return this.context.track(this.visit(sessionId, chat))
    }
    // The replay yields a macrotask first (`loadStructuredAgentSessionForReconciliation`).
    const result = await this.slots.run(chat, async () => {
      if (this.disposed) {
        return null
      }
      return this.context.track(this.visit(sessionId, chat))
    })
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
