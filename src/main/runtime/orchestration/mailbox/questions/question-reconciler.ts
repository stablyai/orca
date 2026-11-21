// Runs the agent-question decision on every edge that can change it: a take, mail leaving a
// mailbox a taker was waiting on, a delivery pass or typed pointer ending, a Dispatch or worker
// start changing, a chat's status observed or closed, a terminal agent's phase, and the database
// opening. No timers: each edge decides with fresh facts, one decision per taker at a time.
import type { OrchestrationDb } from '../../db/orchestration-db'
import { listenForQuestionEdges, type QuestionEdge } from '../../db/messages/question-edges'
import {
  awaitingQuestions,
  awaitingTakers,
  linkedDispatches,
  reconcileQuestions,
  takersLinkedTo,
  type QuestionNoticeWriter
} from './question-reconcile'
import {
  dispatchParty,
  readQuestionPartyFacts,
  type QuestionPartyReads
} from './question-party-facts'

export type QuestionReconcilerDeps = {
  reads: QuestionPartyReads
  /** The notice writer for these questions, with any wording facts read first. */
  notices(taker: string, messageIds: readonly string[]): Promise<QuestionNoticeWriter>
  /** The taker key of a chat or terminal agent, from a live session id or a pty. */
  sessionParty(sessionId: string): string
  terminalParty(ptyId: string): string | null
}

export class QuestionReconciler {
  /** Takers holding a question whose asker may be owed a notice. */
  private readonly awaiting = new Set<string>()
  /** Linked workers (and their helpers), to the takers whose questions they were started for. */
  private readonly linked = new Map<string, Set<string>>()
  /** Mailboxes whose mail held a taker at its last decision. */
  private readonly watched = new Map<string, Set<string>>()
  private readonly queued = new Set<string>()
  /** Takers holding a question whose asker couldn't be verified yet: any chat's change may fix it. */
  private readonly unverified = new Set<string>()
  /** Takers whose decision is reading facts now: any edge decides them again after it. */
  private readonly deciding = new Set<string>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly db: OrchestrationDb,
    private readonly deps: QuestionReconcilerDeps
  ) {}

  /** Listens for the database's edges and decides every taker the database still holds. */
  start(): () => void {
    const stop = listenForQuestionEdges((edge) => this.onEdge(edge))
    this.decideAll()
    return stop
  }

  /** Every taker still awaiting: at open, and when sender records change (unverified askers). */
  decideAll(): void {
    for (const taker of awaitingTakers(this.db)) {
      this.request(taker)
    }
  }

  /** A chat's status was observed, or it closed (running false). */
  chatObserved(sessionId: string, running: boolean): void {
    // A /clear successor's first observation is when its asker becomes verifiable.
    this.unverified.forEach((taker) => this.request(taker))
    if (!running && this.watching()) {
      this.partyChanged(this.deps.sessionParty(sessionId))
    }
  }

  terminalChanged(party: string | null, working: boolean): void {
    if (!working && party) {
      this.partyChanged(party)
    }
  }

  /** Decides this taker's questions, after any decision already running for it. */
  request(taker: string): void {
    if (this.queued.has(taker)) {
      return
    }
    this.queued.add(taker)
    const next = (this.chains.get(taker) ?? Promise.resolve())
      .then(() => {
        this.queued.delete(taker)
        return this.decide(taker)
      })
      .catch((error: unknown) => {
        console.warn('[agent-questions] a question decision failed', error)
      })
    this.chains.set(taker, next)
    void next.then(() => {
      if (this.chains.get(taker) === next) {
        this.chains.delete(taker)
      }
    })
  }

  /** Resolves once every queued decision has run; tests and shutdown only. */
  async settled(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all(this.chains.values())
    }
  }

  /** Whether any question waits on an edge; false skips every lookup. */
  watching(): boolean {
    return this.awaiting.size > 0 || this.linked.size > 0 || this.deciding.size > 0
  }

  private onEdge(edge: QuestionEdge): void {
    // Facts a running decision read may already be stale: it decides again.
    this.deciding.forEach((taker) => this.request(taker))
    switch (edge.kind) {
      case 'take':
        this.request(edge.taker)
        return
      case 'dispatch':
        if (this.awaiting.size > 0) {
          takersLinkedTo(this.db, edge.id).forEach((taker) => this.request(taker))
        }
        return
      case 'mailbox':
        this.watched.get(edge.mailbox)?.forEach((taker) => this.request(taker))
        return
      case 'pane':
        if (this.watching()) {
          this.terminalChanged(this.deps.terminalParty(edge.ptyId), false)
        }
        return
      case 'mail':
        if (this.watched.size > 0) {
          for (const mailbox of this.mailboxesOf(edge.ids)) {
            this.watched.get(mailbox)?.forEach((taker) => this.request(taker))
          }
        }
    }
  }

  private partyChanged(party: string): void {
    this.deciding.forEach((taker) => this.request(taker))
    if (this.awaiting.has(party)) {
      this.request(party)
    }
    this.linked.get(party)?.forEach((taker) => this.request(taker))
  }

  private mailboxesOf(ids: readonly string[]): string[] {
    return this.db.db
      .prepare(
        `SELECT DISTINCT to_handle FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids)
      .flatMap(({ to_handle }) => (typeof to_handle === 'string' ? [to_handle] : []))
  }

  private forget(taker: string): void {
    this.awaiting.delete(taker)
    for (const map of [this.linked, this.watched]) {
      for (const [key, takers] of map) {
        takers.delete(taker)
        if (takers.size === 0) {
          map.delete(key)
        }
      }
    }
  }

  private async decide(taker: string): Promise<void> {
    this.deciding.add(taker)
    try {
      await this.decideNow(taker)
    } finally {
      this.deciding.delete(taker)
    }
  }

  private async decideNow(taker: string): Promise<void> {
    const questions = awaitingQuestions(this.db, taker)
    if (questions.length === 0) {
      this.forget(taker)
      this.unverified.delete(taker)
      return
    }
    const workers = questions.flatMap((id) =>
      linkedDispatches(this.db, id).flatMap(
        (dispatchId) => dispatchParty(this.db, dispatchId) ?? []
      )
    )
    const facts = await readQuestionPartyFacts(this.db, this.deps.reads, [taker, ...workers])
    const write = await this.deps.notices(taker, questions)
    let unverified = false
    const told = new Set(
      reconcileQuestions(
        this.db,
        facts,
        (notice) => {
          const result = write(notice)
          unverified ||= result === 'unverified'
          return result
        },
        taker
      ).map((notice) => notice.messageId)
    )
    if (unverified) {
      this.unverified.add(taker)
    } else {
      this.unverified.delete(taker)
    }
    this.forget(taker)
    if (questions.every((id) => told.has(id))) {
      return
    }
    // Still held: remember what holds it, so the edge that ends the hold decides again.
    this.awaiting.add(taker)
    for (const party of [taker, ...workers]) {
      if (party !== taker) {
        this.add(this.linked, party, taker)
      }
      for (const mailbox of facts.mailboxes(party)) {
        this.add(this.watched, mailbox, taker)
      }
    }
  }

  private add(map: Map<string, Set<string>>, key: string, taker: string): void {
    const takers = map.get(key) ?? new Set<string>()
    takers.add(taker)
    map.set(key, takers)
  }
}
