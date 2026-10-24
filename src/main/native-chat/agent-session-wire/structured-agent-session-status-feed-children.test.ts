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
import { acpChildWorkStatusSink } from '../../acp/acp-structured-child-work.test-support'
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
/** Legacy Codex task IDs retain their old unaddressable-by-Stop prefix. */
const LEGACY_TASK = {
  id: 'codex-agent:task-1',
  kind: 'agent',
  name: 'deep_review',
  state: 'working',
  startedAt: 100,
  stoppable: false
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
    publishChildWork: (_subject, evidence) => {
      admitted.push(evidence)
    },
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

    // Per-tick usage/freshness belongs on the chat channel, avoiding full broadcasts to remote lists.
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

    views = [childView({ observedAt: 60_101, operation: { ...operation, observedAt: 60_101 } })]
    feed.publish(SESSION, journal)
    expect(events).toHaveLength(before + 1)

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
    // Legacy blocked failures would otherwise keep old clients’ parent status working.
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
    expect(retirements()).toHaveLength(0)
    await accept('send-1')
    expect(retirements()).toHaveLength(1)
    await turn('turn-1', 'running')
    feed.publish(SESSION)
    await turn('turn-1', 'completed')
    feed.publish(SESSION)
    await turn('child-turn', 'running', 'child-thread')
    feed.publish(SESSION)
    await turn('wake-turn', 'running')
    feed.publish(SESSION)
    expect(retirements()).toHaveLength(1)

    await send('send-2')
    await accept('send-2')
    feed.publish(SESSION)
    expect(retirements()).toHaveLength(2)

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
    // Reloads must project retained records after the store retires them.
    feed.subscribe({ id: 'list-2', emit: (event) => events.push(event) })
    const snapshot = events.at(-1)
    expect(snapshot?.type === 'snapshot' ? snapshot.sessions[0] : null).not.toHaveProperty(
      'children'
    )
  })
})

describe('structured status feed over the real child-record store', () => {
  it('records every helper of a busy chat, and its next accepted send removes every settled one', async () => {
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
    const { sink, views } = acpChildWorkStatusSink()
    const feed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([[SESSION, indexedStatusFeedSession({ journal })]]),
      getRecord: () => null,
      now: () => 1_000,
      statusSink: () => sink
    })
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION)
    const live = (id: string, kind: 'agent' | 'command'): AgentChildWorkEvidence => ({
      type: 'live',
      observedAt: 100,
      child: {
        handle: { idKind: 'task_id', id },
        kind,
        residency: 'background',
        state: 'working',
        stoppable: true
      }
    })
    const finished = Array.from({ length: 2_049 }, (_, index) => `finished-${index}`)
    feed.publishChildWork(SESSION, [
      ...finished.map((id) => live(id, 'agent')),
      ...Array.from({ length: 40 }, (_, index) => live(`subagent-${index}`, 'agent')),
      ...Array.from({ length: 300 }, (_, index) => live(`task-${index}`, 'command'))
    ])
    feed.publishChildWork(
      SESSION,
      finished.map((id): AgentChildWorkEvidence => ({
        type: 'ended',
        observedAt: 200,
        handle: { idKind: 'task_id', id },
        outcome: 'succeeded'
      }))
    )
    expect(views()).toHaveLength(2_389)
    expect(views().filter((view) => view.membership === 'settled')).toHaveLength(2_049)
    expect(feed.childWorkIncomplete(SESSION)).toBe(false)

    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'send-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'accepted',
      providerIdentity: { ...USER_IDENTITY, ordinal: USER_IDENTITY.ordinal + 1 },
      fence: 1
    })
    feed.publish(SESSION)
    expect(views()).toHaveLength(340)
    expect(views().every((view) => view.membership === 'live')).toBe(true)
    expect(feed.childWorkIncomplete(SESSION)).toBe(false)
  }, 60_000)
})
