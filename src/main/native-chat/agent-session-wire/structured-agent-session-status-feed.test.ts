import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const SESSION = 'status-session'
const TURN_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
} as const
const USER_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
} as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-'))
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

function indexed(session: { journal: Awaited<ReturnType<typeof openJournal>> }) {
  return {
    journal: session.journal,
    params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' as const }
  }
}

function feedFor(sessions: Map<string, { journal: Awaited<ReturnType<typeof openJournal>> }>) {
  let now = 1_000
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: {
      get: (sessionId: string) => {
        const session = sessions.get(sessionId)
        return session ? indexed(session) : undefined
      },
      [Symbol.iterator]: function* () {
        for (const [sessionId, session] of sessions) {
          yield [sessionId, indexed(session)] as const
        }
      }
    } as unknown as ReadonlyMap<string, ReturnType<typeof indexed>>,
    getRecord: () => null,
    now: () => (now += 1)
  })
  const events: AgentSessionStatusEvent[] = []
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  return { feed, events, dispose }
}

describe('StructuredAgentSessionStatusFeed', () => {
  it('opens with every readable session and reports no status before a persisted turn', async () => {
    const journal = await openJournal()
    const { events } = feedFor(new Map([[SESSION, { journal }]]))

    expect(events).toEqual([
      {
        type: 'snapshot',
        sessions: [
          {
            sessionId: SESSION,
            workspaceId: 'workspace-1',
            agent: 'codex',
            status: null,
            latestPrompt: '',
            updatedAt: expect.any(Number)
          }
        ]
      }
    ])
  })

  it('publishes working, then idle once the running marker is tombstoned, and never a repeat', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )

    feed.publish(SESSION)
    feed.publish(SESSION)
    expect(events.slice(1)).toEqual([
      {
        type: 'status',
        session: expect.objectContaining({
          sessionId: SESSION,
          status: 'working',
          latestPrompt: 'write a poem'
        })
      }
    ])

    await journal.appendTombstone(TURN_IDENTITY, { fence: 1 })
    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, status: 'idle' })
    })
    expect(events).toHaveLength(3)
  })

  it('reports a pending approval as attention', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run it' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 1 }
    )

    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'attention' })
    })
  })

  it('keeps the last projection for an evicted session and serves it to a new subscriber', async () => {
    const journal = await openJournal()
    const sessions = new Map([[SESSION, { journal }]])
    const { feed, events } = feedFor(sessions)
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle', latestPrompt: 'hello' })
    })

    // Eviction drops the host's index entry; the projection it already made stays true.
    sessions.delete(SESSION)
    feed.publish(SESSION)
    const late: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'list-late', emit: (event) => late.push(event) })

    expect(events).toHaveLength(2)
    expect(late).toEqual([
      {
        type: 'snapshot',
        sessions: [expect.objectContaining({ sessionId: SESSION, status: 'idle' })]
      }
    ])
  })

  it('tells the sitting subscribers about a change a new subscriber re-projected', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    // Journal appends and the feed's publish are separate queue submissions, so the journal
    // can already hold the turn when a second client connects and re-projects it.
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )

    const late: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'list-late', emit: (event) => late.push(event) })

    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle', latestPrompt: 'hello' })
    })
    // The arriving subscriber reads that same state once, from its snapshot.
    expect(late).toEqual([
      {
        type: 'snapshot',
        sessions: [expect.objectContaining({ status: 'idle', latestPrompt: 'hello' })]
      }
    ])
    // The cache is not left holding a value nobody was told about.
    feed.publish(SESSION)
    expect(events).toHaveLength(2)
  })

  it('ends a closed subscriber and keeps publishing to the rest', async () => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))
    const others: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'list-2', emit: (event) => others.push(event) })

    dispose()
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION)

    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(others.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle' })
    })
  })
})
