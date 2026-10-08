// The status summary reads a session's child records from the sink its row landed in, and derives
// the legacy task list an older client folds from those same records.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'
import {
  indexedStatusFeedSession,
  statusFeedChildView as childView
} from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const SESSION = 'status-session'
const USER_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
} as const
/** The legacy row an older client reads for `childView()`, derived from it. These sessions are
 *  Codex's, so a subagent keeps the id its row carried before views. */
const LEGACY_TASK = {
  id: 'codex-agent:task-1',
  kind: 'agent',
  name: 'deep_review',
  state: 'working',
  startedAt: 100,
  stoppable: true
} as const

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-child-records-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function feedWithChildren(provider: AgentSessionHandleProvider = 'codex') {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(root, SESSION)
  })
  const views: { current: () => AgentChildWorkView[] } = { current: () => [] }
  const admitted: AgentChildWorkEvidence[][] = []
  const changed: string[] = []
  const sink: StructuredAgentSessionStatusSink = {
    publish: () => {},
    forget: () => {},
    publishChildWork: (_subject, evidence) => admitted.push(evidence),
    readChildWork: () => views.current()
  }
  let now = 1_000
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[SESSION, indexedStatusFeedSession({ journal, provider })]]),
    getRecord: () => null,
    now: () => (now += 1),
    statusSink: () => sink,
    onChildWorkChanged: (sessionId) => changed.push(sessionId)
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  await journal.appendItem(
    USER_IDENTITY,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  return { journal, feed, events, views, admitted, changed }
}

function lastSummary(events: AgentSessionStatusEvent[]): AgentSessionStatusSummary | undefined {
  const last = events.at(-1)
  return last?.type === 'status' ? last.session : undefined
}

describe('structured status summary child records', () => {
  it('projects live child records and republishes a record-only state change', async () => {
    const { journal, feed, events, views: read } = await feedWithChildren()
    let views = [childView()]
    read.current = () => views
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION, journal)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ backgroundTasks: [LEGACY_TASK], children: views })
    })

    // No journal change: only the record's state moved.
    views = [childView({ state: 'waiting' })]
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

  it('omits usage and a ticking evidence clock so a progress tick never re-broadcasts', async () => {
    const { journal, feed, events, views: read } = await feedWithChildren()
    const operation = { toolName: 'Bash', input: 'npm test', basis: 'reported' as const }
    let views = [childView({ totalTokens: 10, operation: { ...operation, observedAt: 100 } })]
    read.current = () => views
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION, journal)
    const before = events.length

    // A `task_progress` frame moves usage, which no status-summary reader renders, and the
    // child's evidence clocks; re-broadcasting the whole summary per frame would cost every
    // remote subscriber. The chat strip's channel carries both per tick.
    views = [
      childView({
        totalTokens: 4_200,
        observedAt: 59_000,
        operation: { ...operation, observedAt: 59_000 }
      })
    ]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [LEGACY_TASK],
        children: [childView({ operation: { ...operation, observedAt: 100 } })]
      })
    })

    // The clock re-broadcasts once it moved far enough to change a "no update" minute.
    views = [childView({ observedAt: 60_101, operation: { ...operation, observedAt: 60_101 } })]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 1)

    // What the child is doing, or its state, re-broadcasts at once.
    views = [
      childView({
        observedAt: 60_200,
        operation: { ...operation, toolName: 'Read', observedAt: 60_200 }
      })
    ]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 2)
    views = [childView({ state: 'waiting', observedAt: 60_300 })]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 3)
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({
        backgroundTasks: [expect.objectContaining({ state: 'waiting' })]
      })
    })
  })

  // The sidebar and the strip list running children only; a finished one is on neither.
  it('lists only running children on the summary, and no finished one in any of its lists', async () => {
    const { feed, events, views } = await feedWithChildren()
    const failed = childView({
      id: 'child-2',
      providerId: 'task-2',
      state: 'done',
      membership: 'settled',
      outcome: 'failed',
      settledAt: 150,
      observedAt: 150,
      lastMessage: 'Exit code 1'
    })
    views.current = () => [childView(), failed]
    feed.publish(SESSION)
    // An older client reads a failed task's legacy `blocked` as still running.
    expect(lastSummary(events)).toMatchObject({
      backgroundTasks: [LEGACY_TASK],
      children: [childView()]
    })
    views.current = () => [failed]
    feed.publish(SESSION)
    expect(lastSummary(events)).not.toHaveProperty('children')
    expect(lastSummary(events)).not.toHaveProperty('backgroundTasks')
  })

  it('keeps a finished child on the summary while a shell it launched still runs', async () => {
    const { feed, events, views } = await feedWithChildren()
    const owner = childView({ state: 'done', membership: 'settled', outcome: 'succeeded' })
    const shell = childView({
      id: 'child-2',
      providerId: 'task-2',
      kind: 'command',
      parentChildWorkId: 'child-1'
    })
    views.current = () => [owner, shell]
    feed.publish(SESSION)
    expect(lastSummary(events)?.children).toEqual([owner, shell])
  })

  it("keeps a Claude child's own id, and a Codex subagent's the id its row always carried", async () => {
    const shell = childView({
      id: 'child-2',
      providerId: 'codex-command:primary:cmd-1',
      kind: 'command'
    })
    for (const [provider, agentId] of [
      ['claude', 'task-1'],
      ['codex', 'codex-agent:task-1']
    ] as const) {
      const { feed, events, views } = await feedWithChildren(provider)
      views.current = () => [childView(), shell]
      feed.publish(SESSION)
      expect(lastSummary(events)?.backgroundTasks?.map((task) => task.id)).toEqual([
        agentId,
        'codex-command:primary:cmd-1'
      ])
      // The views name the child as its records do; only the legacy shape is mapped.
      expect(lastSummary(events)?.children?.map((view) => view.providerId)).toEqual([
        'task-1',
        'codex-command:primary:cmd-1'
      ])
      await journals.closeAll()
      await rm(join(root, SESSION), { recursive: true, force: true })
    }
  })

  it('re-reads the records once child work is admitted, and tells the strip', async () => {
    const { feed, events, views, admitted, changed } = await feedWithChildren()
    const edge: AgentChildWorkEvidence = { type: 'session-ended', observedAt: 5 }
    feed.publish(SESSION)
    const before = events.length
    views.current = () => [childView()]
    feed.publishChildWork(SESSION, [edge])
    expect(admitted).toEqual([[edge]])
    expect(changed).toContain(SESSION)
    expect(events).toHaveLength(before + 1)
    expect(lastSummary(events)?.children).toEqual([childView()])
  })

  it("retires finished children at the user's next accepted send, not at a turn nobody sent", async () => {
    const { journal, feed, admitted } = await feedWithChildren()
    const turn = (turnId: string, state: 'running' | 'completed', agentId?: string) =>
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 },
        { kind: 'turn', turnId, state },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...(agentId ? { agentId } : {}) }
      )
    const send = async (clientMessageId: string) => {
      await journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: clientMessageId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
        fence: 1
      })
      feed.publish(SESSION)
    }
    const accept = async (clientMessageId: string) => {
      await journal.resolveDispatch({
        clientMessageId,
        state: 'accepted',
        providerIdentity: { ...USER_IDENTITY, ordinal: USER_IDENTITY.ordinal + 1 },
        fence: 1
      })
      feed.publish(SESSION)
    }
    const retirements = () => admitted.flat().filter((edge) => edge.type === 'turn-started')
    feed.publish(SESSION)
    await send('send-1')
    // Written but not taken: the provider may still refuse it.
    expect(retirements()).toHaveLength(0)
    await accept('send-1')
    expect(retirements()).toHaveLength(1)
    await turn('turn-1', 'running')
    feed.publish(SESSION)
    await turn('turn-1', 'completed')
    feed.publish(SESSION)
    // Neither a subagent's turn nor a turn the provider opened on its own is the user's.
    await turn('child-turn', 'running', 'child-thread')
    feed.publish(SESSION)
    await turn('wake-turn', 'running')
    feed.publish(SESSION)
    expect(retirements()).toHaveLength(1)

    await send('send-2')
    await accept('send-2')
    feed.publish(SESSION)
    expect(retirements()).toHaveLength(2)

    // A rewind replaces the conversation, as the user's own action.
    await journal.replaceEpochItems('handle_forked', 1, [])
    feed.publish(SESSION)
    expect(retirements()).toHaveLength(3)
  })

  it("forgets a closed session's children in the projection it keeps", async () => {
    const { feed, events, views } = await feedWithChildren()
    views.current = () => [childView()]
    feed.publish(SESSION)
    expect(lastSummary(events)?.children).toHaveLength(1)
    feed.close(SESSION)
    expect(lastSummary(events)).not.toHaveProperty('children')
    expect(lastSummary(events)).not.toHaveProperty('backgroundTasks')
  })

  it('stops listing children once the row leaves the sink, even with no close', async () => {
    const { feed, events, views } = await feedWithChildren()
    views.current = () => [childView()]
    feed.publish(SESSION)
    expect(lastSummary(events)?.children).toHaveLength(1)
    feed.forget(SESSION)
    expect(lastSummary(events)).not.toHaveProperty('children')
    // A reload reads the retained projection: it must not list what the store no longer holds.
    feed.subscribe({ id: 'list-2', emit: (event) => events.push(event) })
    const snapshot = events.at(-1)
    expect(snapshot?.type === 'snapshot' ? snapshot.sessions[0] : null).not.toHaveProperty(
      'children'
    )
  })
})
