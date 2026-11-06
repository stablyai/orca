import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status/child-work/agent-status-child-work-view'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { indexedStatusFeedSession as indexed } from './structured-agent-session-status-feed-test-session'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const SESSION = 'status-session'
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
      providerHandle: codexProviderHandle('thread-1')
    },
    now,
    stateDirectory: join(root, sessionId)
  })
}

function feedFor(
  sessions: Map<string, Parameters<typeof indexed>[0]>,
  record: Partial<AgentSessionRecord> | null = null,
  onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged'],
  readChildWork?: () => AgentChildWorkView[],
  statusSink?: StructuredAgentSessionStatusSink
) {
  let now = 1_000
  const sink =
    statusSink ??
    (readChildWork ? { publish: () => {}, forget: () => {}, readChildWork } : undefined)
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    ...(onStatusChanged ? { onStatusChanged } : {}),
    ...(sink ? { statusSink: () => sink } : {}),
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
    // A partial record still has a lease: the feed reads the conversation's fence off it.
    getConversation: () =>
      record ? agentSessionConversationView({ ...agentSessionRecordFixture(), ...record }) : null,
    now: () => (now += 1)
  })
  const events: AgentSessionStatusEvent[] = []
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  return { feed, events, dispose }
}

describe('StructuredAgentSessionStatusFeed', () => {
  it('ends a closed subscriber and keeps publishing to the rest', async () => {
    const journal = await openJournal()
    const { feed, events, dispose } = feedFor(new Map([[SESSION, { journal }]]))
    const others: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'list-2', emit: (event) => others.push(event) })

    dispose()
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION)

    expect(events.at(-1)).toEqual({ type: 'end' })
    expect(others.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle' })
    })
  })
})

// Broadcast cache retains closed history; roster reads must intersect it with live sessions.
describe('the status sink sees the roster the broadcast cache deliberately lacks', () => {
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
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    feed.publish(SESSION, journal)
    expect(() => feed.forget(SESSION)).not.toThrow()
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, status: 'idle' })
    })
  })
})
