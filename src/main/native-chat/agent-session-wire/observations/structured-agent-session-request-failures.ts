import type { AgentJournalSnapshot } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalWriterCommit } from '../../agent-session-journal/journal-writer-changes'
import type { JournalRequestOutcome } from '../../agent-session-journal/journal-request-failure'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session/failures/agent-session-failure-words'

export type StructuredAgentSessionRequestFailure = {
  sessionId: string
  agent: string
  kind: 'turn' | 'refused-send'
  id: string
  outcome: 'failure' | 'interruption'
  capturePendingOutput?: () => (() => boolean) | undefined
  death?: NonNullable<StructuredAgentSessionHostSession['lastEndedChild']> &
    AgentSessionFailureWordsContext
  read: () => Promise<AgentJournalSnapshot | null>
}

type Source = {
  journal: AgentSessionJournal
  epoch: string
  counted: Set<string>
  ended: StructuredAgentSessionHostSession['lastEndedChild']
}

/** The writer supplies outcome edges; the host attaches live authority and deduplicates delivery. */
export class StructuredAgentSessionRequestFailures {
  private readonly sources = new Map<string, Source>()

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
      onFailure: (failure: StructuredAgentSessionRequestFailure) => void
      capturePendingOutput?: StructuredAgentSessionAdapter['capturePendingOutput']
      wordsContext?: (
        sessionId: string
      ) => AgentSessionFailureWordsContext | Promise<AgentSessionFailureWordsContext>
      onError?: (error: unknown) => void
    }
  ) {}

  forget = (sessionId: string): void => {
    this.sources.delete(sessionId)
  }
  clear = (): void => this.sources.clear()

  observe = (
    sessionId: string,
    journal: AgentSessionJournal,
    commit?: JournalWriterCommit
  ): void => {
    const epoch = journal.cursor().epoch
    let source = this.sources.get(sessionId)
    if (!commit || !source || source.journal !== journal || source.epoch !== epoch) {
      source = {
        journal,
        epoch,
        counted: new Set(),
        ended: this.deps.sessions.get(sessionId)?.lastEndedChild
      }
      this.sources.set(sessionId, source)
    }
    if (!commit) {
      return
    }
    const ended = this.deps.sessions.get(sessionId)?.lastEndedChild
    for (const event of commit.requestEvents ?? []) {
      if (event.epoch !== journal.physicalCursor().epoch) {
        continue
      }
      if (event.cleared) {
        source.counted.clear()
      }
      for (const outcome of event.outcomes) {
        this.forward(sessionId, source, outcome, ended)
      }
    }
  }

  generationEnded = async (sessionId: string): Promise<void> => {
    const source = this.sources.get(sessionId)
    const session = this.deps.sessions.get(sessionId)
    const ended = session?.lastEndedChild
    if (!source || !session || source.journal !== session.journal || source.ended === ended) {
      return
    }
    source.ended = ended
    if (!ended?.rootGone || ended.cause !== 'exit') {
      return
    }
    const stopSettle = session.journal.stopMarks.fact()
    await session.journal
      .readInOrder((reads) => reads.runningRequest(stopSettle))
      .then((running) => {
        if (this.current(sessionId, source) && running?.turnState === 'running') {
          this.forward(
            sessionId,
            source,
            { ...running, outcome: 'interruption', linked: undefined },
            ended
          )
        }
      })
      .catch((error) => this.deps.onError?.(error))
  }

  private current(sessionId: string, source: Source): boolean {
    return (
      this.sources.get(sessionId) === source &&
      this.deps.sessions.get(sessionId)?.journal === source.journal &&
      !source.journal.isClosed &&
      source.journal.cursor().epoch === source.epoch
    )
  }

  private forward(
    sessionId: string,
    source: Source,
    candidate: JournalRequestOutcome,
    ended: Source['ended']
  ): void {
    let request = candidate
    const unexpected = (value: JournalRequestOutcome) =>
      ended?.rootGone === true &&
      ended.cause === 'exit' &&
      value.fence === ended.fence &&
      !value.personStopped
    if (request.linked && unexpected(request.linked)) {
      request = request.linked
    }
    if (request.outcome === 'interruption' && !unexpected(request)) {
      return
    }
    const key = `${request.kind}:${request.id}`
    if (source.counted.has(key)) {
      return
    }
    source.counted.add(key)
    const outcome = request.outcome
    const { journal } = source
    const child = this.deps.sessions.get(sessionId)?.child
    const generation = child?.fence === request.fence ? child.generation : undefined
    const clientMessageId = request.clientMessageId
    const death = outcome === 'interruption' && ended ? { ...ended } : undefined
    const words = death ? this.deps.wordsContext?.(sessionId) : undefined
    this.deps.onFailure({
      sessionId,
      agent: journal.identity.agent,
      kind: request.kind,
      id: request.id,
      outcome,
      death,
      capturePendingOutput: () =>
        clientMessageId && generation
          ? this.deps.capturePendingOutput?.({
              sessionId,
              clientMessageId,
              fence: request.fence,
              generation
            })
          : undefined,
      read: () =>
        journal.readInOrder(async (reads) => {
          if (!this.current(sessionId, source)) {
            return null
          }
          if (death && words) {
            Object.assign(death, await words)
          }
          const snapshot = await reads.requestFailure(request.kind, request.id)
          return this.current(sessionId, source) ? snapshot : null
        })
    })
  }
}
