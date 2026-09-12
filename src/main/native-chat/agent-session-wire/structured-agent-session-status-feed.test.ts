import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionBackgroundTask,
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { publishCodexTurnLifecycle } from '../../codex/codex-structured-journal-translation-turns'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
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

function indexed(session: {
  journal: Awaited<ReturnType<typeof openJournal>>
  hasProviderChild?: boolean
  fence?: number
}) {
  return {
    journal: session.journal,
    fence: session.fence ?? 1,
    ...(session.hasProviderChild !== undefined
      ? { hasProviderChild: session.hasProviderChild }
      : {}),
    params: {
      location: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree' as const
      },
      provider: 'codex' as const
    }
  }
}

function feedFor(
  sessions: Map<
    string,
    { journal: Awaited<ReturnType<typeof openJournal>>; hasProviderChild?: boolean; fence?: number }
  >,
  record: Partial<AgentSessionRecord> | null = null,
  onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged'],
  readBackgroundTasks?: StructuredAgentSessionStatusFeedDeps['readBackgroundTasks'],
  statusSink?: StructuredAgentSessionStatusSink
) {
  let now = 1_000
  const feed = new StructuredAgentSessionStatusFeed({
    ...(onStatusChanged ? { onStatusChanged } : {}),
    ...(statusSink ? { statusSink: () => statusSink } : {}),
    ...(readBackgroundTasks ? { readBackgroundTasks } : {}),
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
  it('publishes provider ownership transitions without changing journal time', async () => {
    const journal = await openJournal()
    const sessions = new Map([[SESSION, { journal, hasProviderChild: true }]])
    const { feed, events, dispose } = feedFor(sessions)
    events.length = 0
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ hostExecutionOwned: true, updatedAt: expect.any(Number) })
    })
    const firstStatus = events.at(-1)
    expect(firstStatus?.type).toBe('status')
    if (firstStatus?.type !== 'status') {
      throw new Error('status publication missing')
    }
    const journalTime = firstStatus.session.updatedAt
    sessions.get(SESSION)!.hasProviderChild = false
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle', updatedAt: journalTime })
    })
    const secondStatus = events.at(-1)
    expect(secondStatus?.type).toBe('status')
    if (secondStatus?.type === 'status') {
      expect(secondStatus.session).not.toHaveProperty('hostExecutionOwned')
    }
    dispose()
  })

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

  it('stops projecting an old-host unknown submission after the owner fence advances', async () => {
    const journal = await openJournal()
    const session = { journal, fence: 1 }
    const { feed, events } = feedFor(new Map([[SESSION, session]]))
    await journal.appendSubmission({
      clientMessageId: 'old-host',
      payloadFingerprint: 'fp',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'slow' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'old-host',
      state: 'unknown',
      reason: 'ack timeout',
      fence: 1
    })
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({ session: { status: 'working' } })
    session.fence = 2
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({ session: { status: 'idle' } })
  })

  it('publishes working from the pending submission, before the provider replays the turn', async () => {
    const journal = await openJournal()
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]))
    events.length = 0
    await journal.appendSubmission({
      clientMessageId: 'client-1',
      payloadFingerprint: 'fingerprint-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
      fence: 1
    })

    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'working' })
    })

    await journal.resolveDispatch({
      clientMessageId: 'client-1',
      state: 'accepted',
      providerIdentity: USER_IDENTITY,
      fence: 1
    })
    feed.publish(SESSION)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle' })
    })
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

  it('reuses the journal projection across task progress and invalidates on journal changes', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    await journal.appendItem(
      TURN_IDENTITY,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1 }
    )
    const snapshot = vi.spyOn(journal, 'snapshot')
    let taskState: 'working' | 'waiting' = 'working'
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), null, undefined, () => ({
      state: 'monitoring',
      tasks: [{ id: 'child', kind: 'agent', state: taskState }]
    }))
    for (let tick = 1; tick <= 100; tick++) {
      taskState = tick % 2 === 1 ? 'waiting' : 'working'
      feed.publish(SESSION)
    }
    expect(events).toHaveLength(101)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { status: 'working', backgroundTasks: [{ state: 'working' }] }
    })
    await journal.appendTombstone(TURN_IDENTITY, { fence: 1 })
    feed.publish(SESSION)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toMatchObject({ type: 'status', session: { status: 'idle' } })
  })

  it('invalidates cached status on unreadability and keeps record metadata live', async () => {
    const journal = await openJournal()
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    const record = { options: { model: 'first-model' }, providerHandleChain: [] }
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), record)
    record.options.model = 'second-model'
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: { status: 'idle', model: 'second-model' }
    })
    const readOnly = vi.spyOn(journal, 'isReadOnly', 'get').mockReturnValue(true)
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({ type: 'status', session: { status: null } })
    readOnly.mockRestore()
    feed.publish(SESSION)
    expect(events.at(-1)).toMatchObject({ type: 'status', session: { status: 'idle' } })
  })

  it('projects live background tasks and republishes a task-only state change', async () => {
    const journal = await openJournal()
    let tasks = [
      { id: 'task-1', kind: 'agent' as const, name: 'deep_review', state: 'working' as const }
    ]
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), null, undefined, () => ({
      state: 'monitoring',
      tasks
    }))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [{ id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working' }]
      })
    })

    // No journal change: only the task state moved.
    tasks = [{ id: 'task-1', kind: 'agent', name: 'deep_review', state: 'waiting' as never }]
    const before = events.length
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [expect.objectContaining({ state: 'waiting' })]
      })
    })

    // An identical projection is suppressed.
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 1)
  })

  it('omits task usage so a progress tick never re-broadcasts the summary', async () => {
    const journal = await openJournal()
    let tasks: AgentSessionBackgroundTask[] = [
      { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working', totalTokens: 10 }
    ]
    const { feed, events } = feedFor(new Map([[SESSION, { journal }]]), null, undefined, () => ({
      state: 'monitoring',
      tasks
    }))
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    const before = events.length

    // A `task_progress` frame moves only usage, which no status-summary reader renders;
    // re-broadcasting the whole summary per frame would cost every remote subscriber.
    tasks = [
      { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working', totalTokens: 4_200 }
    ]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [{ id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working' }]
      })
    })

    // A state change on the same task still reaches subscribers.
    tasks = [
      { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'waiting', totalTokens: 4_200 }
    ]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [expect.objectContaining({ state: 'waiting' })]
      })
    })
  })
})

/**
 * `published` is a broadcast cache, not a roster. It deliberately never retracts — an evicted idle
 * session is still idle, and a reloading renderer must not lose every settled row — so enumerating
 * it lists every session this host has ever opened. Eviction's `forget-session` step deletes the
 * session from the live map and touches nothing else, so a poller has to intersect with that map.
 */
describe('the status sink sees the roster the broadcast cache deliberately lacks', () => {
  function sinkFor() {
    const published: AgentSessionStatusSummary[] = []
    const forgotten: string[] = []
    const sink: StructuredAgentSessionStatusSink = {
      publish: (_subject, summary) => published.push(summary),
      forget: (subject) => {
        if (subject.kind === 'structured-session') {
          forgotten.push(subject.sessionId)
        }
      }
    }
    return { sink, published, forgotten }
  }

  it('receives every change once, ownership revocation, and the forget edge', async () => {
    const journal = await openJournal()
    const sessions = new Map([[SESSION, { journal, hasProviderChild: true }]])
    const { sink, published, forgotten } = sinkFor()
    const { feed } = feedFor(sessions, null, undefined, undefined, sink)
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    // A second identical publication is deduped for the sink exactly as for subscribers, so the
    // sink saw two writes: the opening projection the harness's subscriber triggered, then this.
    feed.publish(SESSION, journal)
    expect(published.map((summary) => summary.status)).toEqual([null, 'idle'])
    expect(published.at(-1)).toMatchObject({
      sessionId: SESSION,
      status: 'idle',
      hostExecutionOwned: true
    })

    feed.revokeLive(SESSION)
    expect(published.at(-1)).toMatchObject({ sessionId: SESSION, status: 'idle' })
    expect(published.at(-1)?.hostExecutionOwned).toBeUndefined()

    // Exactly what `close` does after eviction: the cache keeps the projection, the sink does not.
    sessions.delete(SESSION)
    feed.forget(SESSION)
    expect(forgotten).toEqual([SESSION])
    const late: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'list-2', emit: (event) => late.push(event) })
    expect(late).toEqual([
      {
        type: 'snapshot',
        sessions: [expect.objectContaining({ sessionId: SESSION, status: 'idle' })]
      }
    ])
  })

  it('keeps publishing to subscribers when the sink throws', async () => {
    const journal = await openJournal()
    const sink: StructuredAgentSessionStatusSink = {
      publish: () => {
        throw new Error('store down')
      },
      forget: () => {
        throw new Error('store down')
      }
    }
    const { feed, events } = feedFor(
      new Map([[SESSION, { journal }]]),
      null,
      undefined,
      undefined,
      sink
    )
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION, journal)
    expect(() => feed.forget(SESSION)).not.toThrow()
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, status: 'idle' })
    })
  })
})
