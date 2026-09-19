import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalTurnLifecycle } from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { StructuredTurnCompletionEvent } from '../../../shared/structured-turn-completion'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { indexedStatusFeedSession as indexed } from './structured-agent-session-status-feed-test-session'
import { StructuredTurnCompletionFeed } from './structured-turn-completion-feed'

const SESSION = 'completion-session'
const TURN_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
} as const
const USER_IDENTITY = { ...TURN_IDENTITY, ordinal: 1 } as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-turn-completion-feed-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function openJournal(sessionId = SESSION) {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: join(root, sessionId)
  })
}

type Journal = Awaited<ReturnType<typeof openJournal>>

/** The host's own session index, built for real rather than faked: `indexedStatusFeedSession`
 *  already produces the journal-plus-location shape the feed reads. */
function sessionIndex(sessions: Map<string, { journal: Journal }>) {
  return new Map([...sessions].map(([sessionId, session]) => [sessionId, indexed(session)]))
}

function feedFor(sessions: Map<string, { journal: Journal }>) {
  const feed = new StructuredTurnCompletionFeed({
    sessions: sessionIndex(sessions),
    now: () => 9_000
  })
  const events: StructuredTurnCompletionEvent[] = []
  const dispose = feed.subscribe({
    id: 'window-1',
    emit: (event) => events.push(event)
  })
  return { feed, events, dispose }
}

/** A root turn record, as the journal holds it. Child turns write no turn record at all. */
async function writeTurn(journal: Journal, turn: AgentJournalTurnLifecycle): Promise<void> {
  await journal.appendItem(TURN_IDENTITY, agentJournalTurnBody(turn), {
    fence: 1
  })
}

async function writeUserMessage(journal: Journal): Promise<void> {
  await journal.appendItem(
    USER_IDENTITY,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }]
    },
    { fence: 1 }
  )
}

function completions(events: StructuredTurnCompletionEvent[]) {
  return events.flatMap((event) => (event.type === 'completion' ? [event.completion] : []))
}

describe('StructuredTurnCompletionFeed', () => {
  it('announces a root turn that settles with a recorded verdict, scoped for dedupe', async () => {
    const journal = await openJournal()
    const sessions = new Map([[SESSION, { journal }]])
    const { feed, events, dispose } = feedFor(sessions)

    feed.baseline(SESSION)
    await writeUserMessage(journal)
    await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
    feed.observe(SESSION, journal)
    expect(completions(events)).toEqual([])

    await writeTurn(journal, {
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'success',
      completedAt: 4_242
    })
    feed.observe(SESSION, journal)

    expect(completions(events)).toEqual([
      {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree'
        },
        sessionId: SESSION,
        turnId: 'turn-1',
        outcome: 'success',
        completedAt: 4_242
      }
    ])
    dispose()
  })

  it.each([
    { outcome: 'failure' as const, state: 'completed' as const },
    { outcome: 'cancellation' as const, state: 'interrupted' as const }
  ])('announces $outcome so a consumer can decline it', async ({ outcome, state }) => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

    feed.baseline(SESSION)
    await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
    feed.observe(SESSION, journal)
    await writeTurn(journal, {
      turnId: 'turn-1',
      state,
      outcome,
      completedAt: 7
    })
    feed.observe(SESSION, journal)

    expect(completions(events).map((completion) => completion.outcome)).toEqual([outcome])
    dispose()
  })

  it('stays silent for a turn whose verdict was never recorded', async () => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

    feed.baseline(SESSION)
    await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
    feed.observe(SESSION, journal)
    // An older host, or an end this host inferred rather than heard. Absent is UNKNOWN, and
    // `completed` on its own is also what a provider API error is recorded as.
    await writeTurn(journal, {
      turnId: 'turn-1',
      state: 'completed',
      completedAt: 7
    })
    feed.observe(SESSION, journal)

    expect(completions(events)).toEqual([])
    dispose()
  })

  describe('live-only recovery', () => {
    it('baselines a session whose turn already finished before the feed saw it', async () => {
      const journal = await openJournal()
      await writeTurn(journal, {
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        completedAt: 1
      })
      const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

      // Restore, restart and rewind all arrive here. A restored session is not a completing one.
      feed.baseline(SESSION)
      feed.observe(SESSION, journal)

      expect(completions(events)).toEqual([])
      dispose()
    })

    it('baselines on the commit edge too, when that is the first sight of the session', async () => {
      const journal = await openJournal()
      await writeTurn(journal, {
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        completedAt: 1
      })
      const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

      feed.observe(SESSION, journal)

      expect(completions(events)).toEqual([])
      dispose()
    })

    it('opens a subscriber on nothing, so a completion it missed is dropped not replayed', async () => {
      const journal = await openJournal()
      const sessions = new Map([[SESSION, { journal }]])
      const { feed, dispose } = feedFor(sessions)
      feed.baseline(SESSION)
      await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
      feed.observe(SESSION, journal)
      await writeTurn(journal, {
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        completedAt: 1
      })
      feed.observe(SESSION, journal)
      dispose()

      // A second window connects after the fact. Catch-up is deliberately absent: if this ever
      // starts returning the earlier completion, recovery has silently become replay.
      const late: StructuredTurnCompletionEvent[] = []
      const disposeLate = feed.subscribe({
        id: 'window-2',
        emit: (event) => late.push(event)
      })
      expect(late).toEqual([])

      feed.observe(SESSION, journal)
      expect(late).toEqual([])
      disposeLate()
    })

    it('never re-announces a turn it already accounted for', async () => {
      const journal = await openJournal()
      const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

      feed.baseline(SESSION)
      await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
      feed.observe(SESSION, journal)
      await writeTurn(journal, {
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        completedAt: 1
      })
      // An event-recovery snapshot and a rewind both re-publish a journal whose newest turn is
      // one this feed has already reported.
      feed.observe(SESSION, journal)
      feed.observe(SESSION, journal)
      feed.observe(SESSION, journal)
      feed.baseline(SESSION)

      expect(completions(events)).toHaveLength(1)
      dispose()
    })

    it('forgets a closed session rather than retaining its turn bookkeeping', async () => {
      const journal = await openJournal()
      const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

      feed.baseline(SESSION)
      await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
      feed.observe(SESSION, journal)
      feed.forget(SESSION)
      await writeTurn(journal, {
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        completedAt: 1
      })
      // Re-attaching is a fresh baseline, so the turn that settled while closed stays quiet.
      feed.observe(SESSION, journal)

      expect(completions(events)).toEqual([])
      dispose()
    })
  })

  it('emits nothing for a session this host does not hold', async () => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))

    feed.baseline('some-other-session')
    feed.observe('some-other-session')

    expect(events).toEqual([])
    dispose()
  })

  it('drops a subscriber whose transport throws instead of poisoning the others', async () => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))
    feed.subscribe({
      id: 'dead-window',
      emit: () => {
        throw new Error('transport gone')
      }
    })

    feed.baseline(SESSION)
    await writeTurn(journal, { turnId: 'turn-1', state: 'running' })
    feed.observe(SESSION, journal)
    await writeTurn(journal, {
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'success',
      completedAt: 1
    })
    feed.observe(SESSION, journal)

    expect(completions(events)).toHaveLength(1)
    dispose()
  })

  it('ends the stream on unsubscribe so a client can tell teardown from silence', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))

    feed.unsubscribe('window-1')

    expect(events).toEqual([{ type: 'end' }])
  })
})
