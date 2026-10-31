import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLatestRequest } from '../../shared/structured-agent-session-latest-request'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { JournalPublication } from '../native-chat/agent-session-wire/structured-agent-session-conversations'

type Claim = {
  runId: string
  sessionId: string
  messageId: string
  keys: Set<string>
  submissionId?: string
  turnItemId?: string
  turnId?: string
}
type SessionClaims = {
  messages: Map<string, Claim>
  users: Map<string, Claim>
  requests: Map<string, Claim>
  roots: Map<string, Claim>
}

/** Exact causal interests belong to the journal publication lifetime, never the output observer. */
export class AutomationChatInterests {
  private readonly runs = new Map<string, Claim>()
  private readonly sessions = new Map<string, SessionClaims>()

  register(runId: string, sessionId: string, messageId: string): void {
    const prior = this.runs.get(runId)
    if (prior?.sessionId === sessionId && prior.messageId === messageId) {
      return
    }
    this.forget(runId)
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { messages: new Map(), users: new Map(), requests: new Map(), roots: new Map() }
      this.sessions.set(sessionId, session)
    }
    const claim: Claim = { runId, sessionId, messageId, keys: new Set() }
    this.runs.set(runId, claim)
    this.bind(session.messages, messageId, claim)
    this.bind(session.users, agentJournalSubmissionKey(messageId), claim)
  }

  adopt(runId: string, journal: AgentSessionJournal | undefined): void {
    const claim = this.runs.get(runId)
    if (!claim || !journal) {
      return
    }
    const entry = journal.submission(
      journal.queuedMessages.get(claim.messageId)?.consumedAs ?? claim.messageId
    )
    if (entry) {
      this.submission(this.sessions.get(claim.sessionId)!, journal, entry)
    }
  }

  settle(runId: string, read: (sessionId: string) => AgentSessionJournal | undefined): void {
    const claim = this.runs.get(runId)
    if (!claim) {
      return
    }
    const journal = read(claim.sessionId)
    const card = journal?.queuedMessages.get(claim.messageId)
    const submission = journal?.submission(claim.submissionId ?? claim.messageId)
    if (claim.turnItemId || (card && card.state !== 'returned' && card.state !== 'withdrawn')) {
      return
    }
    if (submission && !(submission.queuedMessageId && submission.dispatchState === 'rejected')) {
      return
    }
    this.forget(runId)
  }

  forget(runId: string): void {
    const claim = this.runs.get(runId)
    if (!claim) {
      return
    }
    const session = this.sessions.get(claim.sessionId)
    if (session) {
      for (const key of claim.keys) {
        if (session.messages.get(key) === claim) {
          session.messages.delete(key)
        }
        if (session.users.get(key) === claim) {
          session.users.delete(key)
        }
        if (session.requests.get(key) === claim) {
          session.requests.delete(key)
        }
        if (session.roots.get(key) === claim) {
          session.roots.delete(key)
        }
      }
      if (!session.messages.size) {
        this.sessions.delete(claim.sessionId)
      }
    }
    this.runs.delete(runId)
  }

  clear(): void {
    this.runs.clear()
    this.sessions.clear()
  }

  forgetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    for (const claim of new Set(session.messages.values())) {
      this.forget(claim.runId)
    }
  }

  owns(
    sessionId: string,
    request: Pick<StructuredAgentSessionLatestRequest, 'kind' | 'id'>
  ): boolean {
    return this.sessions.get(sessionId)?.requests.has(`${request.kind}:${request.id}`) === true
  }

  identity(runId: string): { submissionId: string; turnItemId: string | null } | undefined {
    const claim = this.runs.get(runId)
    return claim
      ? {
          submissionId: claim.submissionId ?? claim.messageId,
          turnItemId: claim.turnItemId ?? null
        }
      : undefined
  }

  /** Reset/bootstrap visits each journal once; commits touch only their causal keys. */
  observe(sessionId: string, hint: JournalPublication): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    if (hint.kind === 'end') {
      this.forgetSession(sessionId)
      return
    }
    const journal = hint.journal
    if (hint.kind === 'reset' || hint.kind === 'detach') {
      session.users.clear()
      session.requests.clear()
      session.roots.clear()
      const claims = new Set(session.messages.values())
      session.messages.clear()
      for (const claim of claims) {
        claim.keys.clear()
        claim.submissionId = undefined
        claim.turnItemId = undefined
        claim.turnId = undefined
        this.bind(session.messages, claim.messageId, claim)
        this.bind(session.users, agentJournalSubmissionKey(claim.messageId), claim)
        const card = journal?.queuedMessages.get(claim.messageId)
        if (card?.consumedAs) {
          this.bind(session.messages, card.consumedAs, claim)
        }
      }
      if (!journal) {
        return
      }
      for (const submission of journal.submissions()) {
        this.submission(session, journal, submission)
      }
      journal.visitItemsWithLinkage((id, _sequence, body, item) => {
        if (!item.agentId) {
          this.turn(session, journal, id, body)
        }
      })
      return
    }
    if (!journal) {
      return
    }
    for (const row of hint.rows ?? []) {
      if (row.kind === 'submission' || row.kind === 'dispatch') {
        const submission = journal.submission(row.clientMessageId)
        if (submission) {
          this.submission(session, journal, submission)
        }
      }
      const items = row.kind === 'lifecycle-batch' ? row.mutations : [row]
      for (const item of items) {
        if (item.kind !== 'item' && item.kind !== 'tombstone') {
          continue
        }
        const id = journal.canonicalItemId(item.itemId)
        const current = journal.item(id)
        if (current && !current.agentId) {
          this.turn(session, journal, id, current.body)
        } else if (!current) {
          const claim = session.roots.get(id)
          if (claim) {
            session.requests.delete(`turn:${claim.turnId}`)
            session.roots.delete(id)
            claim.turnId = undefined
            claim.turnItemId = undefined
          }
        }
      }
    }
  }

  private bind(map: Map<string, Claim>, key: string, claim: Claim): void {
    map.set(key, claim)
    claim.keys.add(key)
  }

  private submission(
    session: SessionClaims,
    journal: AgentSessionJournal,
    submission: AgentJournalSubmission
  ): void {
    const claim =
      session.messages.get(submission.clientMessageId) ??
      (submission.queuedMessageId ? session.messages.get(submission.queuedMessageId) : undefined)
    if (!claim) {
      return
    }
    claim.submissionId = submission.clientMessageId
    this.bind(session.messages, submission.clientMessageId, claim)
    this.bind(session.users, agentJournalSubmissionKey(submission.clientMessageId), claim)
    if (submission.providerItemId) {
      this.bind(session.users, submission.providerItemId, claim)
    }
    if (submission.dispatchState === 'rejected' && !submission.queuedMessageId) {
      this.bind(
        session.requests,
        `refused-send:${agentJournalSubmissionKey(submission.clientMessageId)}`,
        claim
      )
    }
    if (submission.answeredInTurn?.via === 'start') {
      const root = journal.item(journal.canonicalItemId(submission.answeredInTurn.turnItemId))
      if (root && !root.agentId) {
        this.turn(session, journal, root.itemId, root.body, claim)
      }
    }
  }

  private turn(
    session: SessionClaims,
    journal: AgentSessionJournal,
    itemId: string,
    body: Parameters<typeof readAgentJournalTurn>[0],
    answered?: Claim
  ): void {
    const turn = readAgentJournalTurn(body)
    if (!turn) {
      return
    }
    const claim =
      answered ??
      (turn.userItemId ? session.users.get(journal.canonicalItemId(turn.userItemId)) : undefined)
    if (claim) {
      if (claim.turnId && claim.turnId !== turn.turnId) {
        session.requests.delete(`turn:${claim.turnId}`)
      }
      if (claim.turnItemId && claim.turnItemId !== itemId) {
        session.roots.delete(claim.turnItemId)
      }
      claim.turnId = turn.turnId
      claim.turnItemId = itemId
      this.bind(session.roots, itemId, claim)
      this.bind(session.requests, `turn:${turn.turnId}`, claim)
    }
  }
}
