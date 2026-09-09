import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { publishCodexTurnLifecycle } from '../../codex/codex-structured-journal-translation-turns'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps
} from './structured-agent-session-status-feed'

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

async function openJournal(sessionId = SESSION, now?: () => number) {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    now,
    journalDir: join(root, sessionId)
  })
}

function indexed(session: { journal: Awaited<ReturnType<typeof openJournal>> }) {
  return {
    journal: session.journal,
    params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' as const }
  }
}

function feedFor(
  sessions: Map<string, { journal: Awaited<ReturnType<typeof openJournal>> }>,
  record: Partial<AgentSessionRecord> | null = null,
  onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged']
) {
  let now = 1_000
  const feed = new StructuredAgentSessionStatusFeed({
    ...(onStatusChanged ? { onStatusChanged } : {}),
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
    getRecord: () => record as AgentSessionRecord | null,
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

  it('preserves the completion tombstone time when the journal and host reopen', async () => {
    let now = 100
    const journal = await openJournal(SESSION, () => now)
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    now = 200
    await journal.appendTombstone(TURN_IDENTITY, { fence: 1 })
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { status: 'idle', updatedAt: 200 }
    })
    await journal.close()
    now = 900
    const reopened = await openJournal(SESSION, () => now)
    const restored = feedFor(new Map([[SESSION, { journal: reopened }]]))
    expect(restored.events[0]).toMatchObject({
      type: 'snapshot',
      sessions: [{ status: 'idle', updatedAt: 200 }]
    })
  })

  it('publishes settled activity revisions and restores the same age after reopening', async () => {
    let now = 100
    const journal = await openJournal(SESSION, () => now)
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    const assistant = { ...USER_IDENTITY, ordinal: 2 }
    await journal.appendItem(
      assistant,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
      { fence: 1 }
    )
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    now = 200
    await journal.appendItem(
      assistant,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'finished' }] },
      { fence: 1 }
    )
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { status: 'idle', updatedAt: 200 }
    })
    feed.publish(SESSION)
    expect(events).toHaveLength(2)
    await journal.close()
    const reopened = await openJournal(SESSION, () => 900)
    const restored = feedFor(new Map([[SESSION, { journal: reopened }]]))
    expect(restored.events[0]).toMatchObject({
      type: 'snapshot',
      sessions: [{ status: 'idle', updatedAt: 200 }]
    })
  })

  it('does not publish timestamp-only revisions while a turn is working', async () => {
    let now = 100
    const journal = await openJournal(SESSION, () => now)
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    for (let revision = 1; revision <= 20; revision += 1) {
      now += 1
      await journal.appendItem(
        TURN_IDENTITY,
        { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
        { fence: 1 }
      )
      feed.publish(SESSION)
    }
    expect(events).toHaveLength(1)
    now = 200
    await journal.appendTombstone(TURN_IDENTITY, { fence: 1 })
    feed.publish(SESSION)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { status: 'idle', updatedAt: 200 }
    })
  })

  it('carries the record model and the running tool line the sidebar row shows', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), {
      options: { model: 'gpt-5-codex' },
      providerHandleChain: []
    })
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run the tests' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )
    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'working', model: 'gpt-5-codex' })
    })

    await journal.appendItem(
      { ...USER_IDENTITY, ordinal: 2 },
      { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
      { fence: 1 }
    )
    feed.publish(SESSION)

    // A tool boundary changes nothing else about the session, so only comparing the new
    // fields keeps it from being deduped away as an unchanged projection.
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ toolName: 'shell', toolInput: 'pnpm test' })
    })
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
  it('reports each projection change to the host observer, marking re-projections as replay', async () => {
    const journal = await openJournal()
    const seen: { status: string | null; prompt: string; replay: boolean }[] = []
    const { feed } = feedFor(new Map([[SESSION, { journal }]]), null, (summary, options) =>
      seen.push({ status: summary.status, prompt: summary.latestPrompt, replay: options.replay })
    )
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fix the auth bug' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )

    feed.publish(SESSION, journal)
    // A second identical publication is deduped, so the observer only ever sees changes.
    feed.publish(SESSION, journal)
    // seen[0] is the opening projection the harness's own subscriber triggered.
    expect(seen.slice(1)).toEqual([
      { status: 'working', prompt: 'fix the auth bug', replay: false }
    ])

    // An arriving subscriber re-projects state the host already knew.
    await journal.appendTombstone(TURN_IDENTITY, { fence: 1 })
    feed.subscribe({ id: 'list-2', emit: () => undefined })
    expect(seen.at(-1)).toEqual({ status: 'idle', prompt: 'fix the auth bug', replay: true })
  })

  it.each(['claude', 'codex'] as const)(
    'observes a fast %s turn even when start and finish queue before persistence',
    async (agent) => {
      const journal = await openJournal()
      await journal.appendItem(
        USER_IDENTITY,
        {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Fix auth' }]
        },
        { fence: 1 }
      )
      const seen: (string | null)[] = []
      const { feed } = feedFor(new Map([[SESSION, { journal }]]), null, (summary) =>
        seen.push(summary.status)
      )
      const deferred = createDeferredStructuredAgentSessionEventSink()
      if (agent === 'claude') {
        const translator = createClaudeJournalTranslator({ sink: deferred.sink })
        translator.handle({
          type: 'message',
          sessionId: SESSION,
          startsTurn: true,
          message: {
            type: 'user',
            uuid: 'prompt-1',
            session_id: 'claude-session',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: 'Fix auth' }] }
          }
        })
        translator.handle({
          type: 'message',
          sessionId: SESSION,
          message: {
            type: 'result',
            subtype: 'success',
            session_id: 'claude-session',
            uuid: 'result-1',
            result: 'Done'
          }
        })
        translator.dispose()
      } else {
        for (const state of ['running', 'completed'] as const) {
          publishCodexTurnLifecycle({
            sink: deferred.sink,
            primaryThreadId: 'thread-1',
            sessionId: SESSION,
            threadId: 'thread-1',
            turnId: 'turn-1',
            state
          })
        }
      }
      for (let index = 0; index < 100; index++) {
        deferred.sink.publish()
      }
      // This queue is also reached while a previous asynchronous journal write is pending.
      let publications = 0
      let activityPublications = 0
      deferred.bind({
        journal,
        fence: 1,
        publish: (activity) => {
          if (activity === undefined) {
            publications += 1
          } else {
            activityPublications += 1
          }
          feed.publish(SESSION, journal)
        }
      })
      expect(await deferred.drained()).toEqual({ ok: true })
      expect(seen).toEqual(['idle', 'working', 'idle'])
      expect(publications).toBe(2)
      expect(activityPublications).toBe(agent === 'claude' ? 1 : 0)
      expect(deferred.state()).toMatchObject({ queuedBytes: 0, queuedOperations: 0 })
      deferred.close()
    }
  )

  it('keeps publishing to subscribers when the host observer throws', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), null, () => {
      throw new Error('observer exploded')
    })
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )

    expect(() => feed.publish(SESSION, journal)).not.toThrow()
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle', latestPrompt: 'hello' })
    })
  })
})
