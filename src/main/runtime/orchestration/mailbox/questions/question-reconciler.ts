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
  remoteAskTakers,
  takersLinkedTo,
  type QuestionNoticeWriter,
  type QuestionPartyFacts
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
  /** Takers holding a question whose asker couldn't be verified yet, and the chats seen since. */
  private readonly unverified = new Set<string>()
  private readonly seenSinceUnverified = new Set<string>()
  /** What changed while each running decision read its facts (`party:`, `mailbox:`, `dispatch:`). */
  private readonly changing = new Set<Set<string>>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly db: OrchestrationDb,
    private readonly deps: QuestionReconcilerDeps
  ) {}

  /** Listens for the database's edges; `decide` picks the takers held from before to decide now. */
  start(decide: (taker: string) => boolean = () => true): () => void {
    const stop = listenForQuestionEdges((edge) => this.onEdge(edge))
    this.decideAll(decide)
    return stop
  }

  /** Every taker still awaiting: at open, when a chat host installs, and on pause or delete. */
  decideAll(decide: (taker: string) => boolean = () => true): void {
    for (const taker of awaitingTakers(this.db)) {
      if (decide(taker)) {
        this.request(taker)
      }
    }
  }

  /** A chat's status was observed, or it closed (running false). */
  chatObserved(sessionId: string, running: boolean): void {
    // A /clear successor's first observation is when its asker becomes verifiable.
    if (this.unverified.size > 0 && !this.seenSinceUnverified.has(sessionId)) {
      this.seenSinceUnverified.add(sessionId)
      this.unverified.forEach((taker) => this.request(taker))
    }
    if (this.watching()) {
      this.partyChanged(this.deps.sessionParty(sessionId), running)
    }
  }

  terminalChanged(party: string | null, working: boolean): void {
    if (party && this.watching()) {
      this.partyChanged(party, working)
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
    return this.awaiting.size > 0 || this.linked.size > 0 || this.changing.size > 0
  }

  private changed(key: string): void {
    this.changing.forEach((keys) => keys.add(key))
  }

  private onEdge(edge: QuestionEdge): void {
    switch (edge.kind) {
      case 'take':
        this.request(edge.taker)
        return
      case 'dispatch':
        this.changed(`dispatch:${edge.id}`)
        if (this.awaiting.size > 0) {
          takersLinkedTo(this.db, edge.id).forEach((taker) => this.request(taker))
        }
        return
      case 'mailbox':
        return this.mailboxChanged(edge.mailbox)
      case 'pane':
        return this.terminalChanged(this.deps.terminalParty(edge.ptyId), false)
      case 'reachable':
        if (this.awaiting.size > 0) {
          remoteAskTakers(this.db, edge.environmentId).forEach((taker) => this.request(taker))
        }
        return
      case 'mail':
        if (this.watched.size > 0 || this.changing.size > 0) {
          this.mailboxesOf(edge.ids).forEach((mailbox) => this.mailboxChanged(mailbox))
        }
    }
  }

  private mailboxChanged(mailbox: string): void {
    this.changed(`mailbox:${mailbox}`)
    this.watched.get(mailbox)?.forEach((taker) => this.request(taker))
  }

  private partyChanged(party: string, running: boolean): void {
    this.changed(`${running ? 'running' : 'party'}:${party}`)
    if (running) {
      return
    }
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
    const questions = awaitingQuestions(this.db, taker).map((question) => question.messageId)
    if (questions.length === 0) {
      this.forget(taker)
      this.unverified.delete(taker)
      return
    }
    const dispatches = questions.flatMap((id) => linkedDispatches(this.db, id))
    const workers = dispatches.flatMap((id) => dispatchParty(this.db, id) ?? [])
    const parties = [taker, ...workers]
    // Wording first, so nothing is awaited between the facts and the write.
    const write = await this.deps.notices(taker, questions)
    const changes = new Set<string>()
    this.changing.add(changes)
    let facts: QuestionPartyFacts
    try {
      facts = await readQuestionPartyFacts(this.db, this.deps.reads, parties)
    } finally {
      this.changing.delete(changes)
    }
    // A party, mailbox or Dispatch it read changed while it read: tell nothing on those facts. A
    // party that started running holds the questions until its stop; anything else decides again.
    const changedWhileRead = (prefix: string) =>
      [
        ...parties.map((party) => `${prefix}:${party}`),
        ...(prefix === 'party'
          ? [
              ...parties.flatMap((party) => facts.mailboxes(party).map((m) => `mailbox:${m}`)),
              ...dispatches.map((id) => `dispatch:${id}`)
            ]
          : [])
      ].some((key) => changes.has(key))
    if (changedWhileRead('party')) {
      this.request(taker)
    } else if (!changedWhileRead('running')) {
      this.record(taker, parties, facts, this.tell(taker, facts, write))
      return
    }
    this.record(taker, parties, facts, questions)
  }

  /** Tells what is owed now; the ids still held. */
  private tell(taker: string, facts: QuestionPartyFacts, write: QuestionNoticeWriter): string[] {
    let unverified = false
    reconcileQuestions(
      this.db,
      facts,
      (notice) => {
        const result = write(notice)
        unverified ||= result === 'unverified'
        return result
      },
      taker
    )
    if (unverified) {
      this.unverified.add(taker)
    } else if (this.unverified.delete(taker) && this.unverified.size === 0) {
      this.seenSinceUnverified.clear()
    }
    return awaitingQuestions(this.db, taker).map((question) => question.messageId)
  }

  /** Remembers what holds a taker's questions, so the edge that ends the hold decides again. */
  private record(
    taker: string,
    parties: readonly string[],
    facts: QuestionPartyFacts,
    held: readonly string[]
  ): void {
    this.forget(taker)
    if (held.length === 0) {
      return
    }
    this.awaiting.add(taker)
    for (const party of parties) {
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
