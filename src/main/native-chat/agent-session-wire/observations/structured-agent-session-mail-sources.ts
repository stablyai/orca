import type {
  JournalMailAttempt,
  JournalMailObservation
} from '../../agent-session-journal/journal-mail-observation'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionHostDeps
} from '../host/structured-agent-session-host-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { copyJournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import { captureHostStructuredAgentSessionWork } from './structured-agent-session-read-work'

export type StructuredMailSourceHold = {
  observations: readonly { attempt: JournalMailAttempt; observation: JournalMailObservation }[]
  current: () => boolean
  release: () => void
}

/** All host positions precede all journal positions; cancellation releases every acquired position. */
export async function holdStructuredMailSources(
  context: {
    serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
    conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
    sessions: Map<string, StructuredAgentSessionHostSession>
    seal: (sessionId: string) => void
    store: StructuredAgentSessionHostDeps['store']
  },
  attempts: readonly JournalMailAttempt[],
  signal: AbortSignal
): Promise<StructuredMailSourceHold> {
  let active = true
  const releases: (() => void)[] = []
  const abandoned = Promise.withResolvers<never>()
  void abandoned.promise.catch(() => undefined)
  const release = () => {
    active = false
    releases
      .splice(0)
      .toReversed()
      .forEach((finish) => finish())
    signal.removeEventListener('abort', abort)
  }
  const abort = () => {
    release()
    abandoned.reject(new Error('mail source acquisition abandoned'))
  }
  const wait = <T>(operation: Promise<T>) => Promise.race([operation, abandoned.promise])
  const hold = async (schedule: (task: () => Promise<void>) => Promise<unknown>) => {
    const entered = Promise.withResolvers<void>()
    const leave = Promise.withResolvers<void>()
    releases.push(() => leave.resolve())
    const queued = schedule(async () => {
      if (!active) {
        return
      }
      entered.resolve()
      await leave.promise
    })
    void queued.catch(entered.reject)
    await wait(entered.promise)
    if (!active) {
      throw new Error('mail source position was released')
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) {
      throw new Error('mail source acquisition aborted')
    }
    const ids = [...new Set(attempts.map((attempt) => attempt.session_id))].sort()
    // Opening owns its own host position; never nest conversation() inside a held host lane.
    for (const id of ids) {
      try {
        await wait(context.conversation(id))
      } catch (error) {
        if (!active) {
          throw error
        }
      }
    }
    for (const id of ids) {
      await hold((task) => context.serialize(id, task))
    }
    const sources = new Map<
      string,
      {
        session: StructuredAgentSessionHostSession
        journal: AgentSessionJournal
        signature: string
        child: StructuredAgentSessionHostSession['child']
      }
    >()
    const signature = (id: string, journal: AgentSessionJournal) =>
      JSON.stringify({
        authority: copyJournalCurrentWorkAuthority(
          captureHostStructuredAgentSessionWork(context, id, journal)
        ),
        cursor: journal.cursor(),
        physical: journal.physicalCursor()
      })
    for (const id of ids) {
      if (!active) {
        throw new Error('mail source acquisition abandoned')
      }
      try {
        const session = context.sessions.get(id)
        if (!session) {
          continue
        }
        context.seal(id)
        sources.set(id, { session, journal: session.journal, signature: '', child: session.child })
      } catch (error) {
        if (!active) {
          throw error
        }
        // Missing authority remains unknown even though its host position is held.
      }
    }
    for (const { journal } of sources.values()) {
      await hold((task) => journal.readInOrder(task))
    }
    for (const [id, source] of sources) {
      source.signature = signature(id, source.journal)
    }
    const current = () =>
      active &&
      [...sources].every(
        ([id, source]) =>
          context.sessions.get(id) === source.session &&
          source.session.journal === source.journal &&
          source.session.child === source.child &&
          !source.journal.isClosed &&
          signature(id, source.journal) === source.signature
      )
    const observations: { attempt: JournalMailAttempt; observation: JournalMailObservation }[] = []
    for (const attempt of attempts) {
      const source = sources.get(attempt.session_id)
      let observation: JournalMailObservation = {
        epoch: '',
        state: { kind: 'unreadable' },
        body: null,
        withdrawal: 'unknown'
      }
      if (source) {
        try {
          observation = await wait(source.journal.reads.mailObservation(attempt))
        } catch (error) {
          if (!active) {
            throw error
          }
        }
      }
      observations.push({ attempt, observation })
    }
    if (!current()) {
      throw new Error('mail source identity changed')
    }
    return { observations, current, release }
  } catch (error) {
    release()
    throw error
  }
}
