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
  /** Undefined when the exit fact already supplies the report. Null when the request is stale. */
  read: () => Promise<AgentJournalSnapshot | null | undefined>
}

/** A provider that died on its own while no request of it was running or failed. */
export type StructuredAgentSessionIdleDeath = {
  sessionId: string
  fence: number
  reason: string | null
}

type Death = {
  ended: NonNullable<StructuredAgentSessionHostSession['lastEndedChild']>
  /** A request failure carries this death to its readers. */
  reported: boolean
  /** The running-turn read, which may forward that failure. */
  running: Promise<void>
}

type Source = {
  journal: AgentSessionJournal
  epoch: string
  counted: Set<string>
  ended: StructuredAgentSessionHostSession['lastEndedChild']
  death?: Death
  recoveredExitRequest?: { fence: number; key: string }
}

/** The writer supplies outcome edges; the host attaches live authority and deduplicates delivery. */
export class StructuredAgentSessionRequestFailures {
  private readonly sources = new Map<string, Source>()

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
      onFailure: (failure: StructuredAgentSessionRequestFailure) => void
      onIdleDeath?: (death: StructuredAgentSessionIdleDeath) => void
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

  /** `settled`: the dead generation's leftovers are written, so every failure it caused was forwarded. */
  generationEnded = async (
    sessionId: string,
    options: { settled?: boolean } = {}
  ): Promise<void> => {
    const source = this.sources.get(sessionId)
    const session = this.deps.sessions.get(sessionId)
    const ended = session?.lastEndedChild
    if (!source || !session || source.journal !== session.journal) {
      return
    }
    if (source.ended === ended) {
      if (options.settled) {
        await this.settleDeath(sessionId, source, ended)
      }
      return
    }
    source.ended = ended
    if (!ended?.rootGone || ended.cause !== 'exit') {
      return
    }
    const stopSettle = session.journal.stopMarks.fact()
    const exit =
      ended.observedAt === undefined
        ? undefined
        : { fence: ended.fence, observedAt: ended.observedAt }
    const running = session.journal
      .readInOrder((reads) => reads.runningRequest(stopSettle, exit))
      .then((request) => {
        if (request && this.current(sessionId, source)) {
          this.forward(
            sessionId,
            source,
            { ...request, outcome: 'interruption', linked: undefined },
            ended,
            request.mark === 'interruption'
          )
        }
      })
      .catch((error) => this.deps.onError?.(error))
    // A failed start is reported by whoever started it.
    if (!ended.duringStartup) {
      source.death = { ended, reported: false, running }
    }
    await running
    if (options.settled) {
      await this.settleDeath(sessionId, source, ended)
    }
  }

  private async settleDeath(
    sessionId: string,
    source: Source,
    ended: Source['ended']
  ): Promise<void> {
    const death = source.death
    if (!death || death.ended !== ended) {
      return
    }
    await death.running
    if (source.death !== death) {
      return
    }
    source.death = undefined
    if (!death.reported && this.current(sessionId, source)) {
      this.deps.onIdleDeath?.({
        sessionId,
        fence: death.ended.fence,
        reason: death.ended.reason
      })
    }
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
    ended: Source['ended'],
    recoveredExit = false
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
    const recovered = source.recoveredExitRequest
    if (source.counted.has(key) || (recovered?.fence === request.fence && recovered.key === key)) {
      return
    }
    if (recoveredExit) {
      // Only the latest proven exit can match a late interruption from the writer.
      source.recoveredExitRequest = { fence: request.fence, key }
    } else {
      source.counted.add(key)
    }
    if (source.death && request.fence === source.death.ended.fence) {
      source.death.reported = true
    }
    const outcome = request.outcome
    const { journal } = source
    const child = this.deps.sessions.get(sessionId)?.child
    const generation = child?.fence === request.fence ? child.generation : undefined
    const clientMessageId = request.clientMessageId
    const death = outcome === 'interruption' && ended ? { ...ended } : undefined
    let words:
      | AgentSessionFailureWordsContext
      | Promise<AgentSessionFailureWordsContext>
      | undefined
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
          if (death?.duringStartup) {
            words ??= this.deps.wordsContext?.(sessionId)
            if (words) {
              Object.assign(death, await words)
            }
          }
          if (recoveredExit) {
            // The adapter supplied this exit's reason with its fence and time.
            return this.current(sessionId, source) ? undefined : null
          }
          const snapshot = await reads.requestFailure(request.kind, request.id)
          return this.current(sessionId, source) ? snapshot : null
        })
    })
  }
}
