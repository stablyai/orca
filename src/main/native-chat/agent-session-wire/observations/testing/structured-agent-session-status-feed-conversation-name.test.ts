import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from '../structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from '../../host/structured-agent-session-logger'
import { agentSessionRecordFixture } from '../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionStatusEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredChatNamingFailure } from '../../host/structured-agent-session-host-types'

const journals = createTrackedJournalOpener()
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-name-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(directory, { recursive: true, force: true })
})

async function namedFeed() {
  const journal = await journals.open({
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('provider')
    },
    stateDirectory: directory,
    now: () => 100
  })
  let record: AgentSessionRecord = { ...agentSessionRecordFixture(), sessionId: 'session' }
  let failure: StructuredChatNamingFailure | undefined
  const sessions = new Map([['session', indexedStatusFeedSession({ journal })]])
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getConversation: (id) =>
      id === record.sessionId ? agentSessionConversationView(record) : null,
    namingFailure: () => failure,
    now: () => 100,
    logger: createStructuredAgentSessionLogger()
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'vault', emit: (event) => events.push(event) })
  feed.publish('session')
  const name = (conversationName: string) => {
    record = { ...record, conversationName }
    feed.publishConversationName('session')
  }
  const fail = (next: StructuredChatNamingFailure) => {
    failure = next
    feed.publishConversationName('session')
  }
  const sleep = (sleptAt: number | undefined) => {
    record = { ...record, sleptAt }
    feed.publishRecordNotes('session')
  }
  return { feed, events, sessions, name, fail, sleep }
}

function lastName(events: readonly AgentSessionStatusEvent[]): string | undefined {
  const event = events.at(-1)
  return event?.type === 'status' ? event.session.conversationName : undefined
}

it('names a chat whose tab closed before naming finished, and keeps it for later subscribers', async () => {
  const { feed, events, sessions, name } = await namedFeed()
  feed.revokeLive('session')
  sessions.clear()
  name('Explain the parser')
  expect(lastName(events)).toBe('Explain the parser')
  const late: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'reloaded', emit: (event) => late.push(event) })
  expect(late.at(-1)).toMatchObject({
    type: 'snapshot',
    sessions: [{ sessionId: 'session', conversationName: 'Explain the parser' }]
  })
})

it('publishes cold names from durable records across a host restart without a status row', () => {
  let record = { ...agentSessionRecordFixture(), conversationName: 'Before' }
  const open = () =>
    new StructuredAgentSessionStatusFeed({
      sessions: new Map(),
      getConversation: () => agentSessionConversationView(record),
      listConversations: () => [agentSessionConversationView(record)],
      now: () => 100,
      logger: createStructuredAgentSessionLogger()
    })
  const feed = open()
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'existing', emit: (event) => events.push(event) })
  record = { ...record, conversationName: 'After' }
  feed.publishConversationName(record.sessionId)
  expect(events.at(-1)).toMatchObject({
    type: 'snapshot',
    sessions: [],
    conversationNames: [{ sessionId: record.sessionId, conversationName: 'After' }]
  })
  expect(feed.readPublished(record.sessionId)).toBeUndefined()
  const restarted: AgentSessionStatusEvent[] = []
  open().subscribe({ id: 'reconnect', emit: (event) => restarted.push(event) })
  expect(restarted[0]).toMatchObject({ conversationNames: [{ conversationName: 'After' }] })
  expect(restarted.at(-1)).toMatchObject({ sessions: [] })
})

it('shows a closed chat its naming failure only while it keeps the name that failed', async () => {
  const { feed, events, sessions, name, fail, sleep } = await namedFeed()
  name('Explain the parser')
  feed.revokeLive('session')
  sessions.clear()
  sleep(5)
  expect(events.at(-1)).toMatchObject({ session: { sleptAt: 5 } })
  fail({ message: 'Agent failed', failedAt: 5, forName: 'Explain the parser' })
  expect(events.at(-1)).toMatchObject({
    type: 'status',
    session: {
      conversationName: 'Explain the parser',
      namingError: { message: 'Agent failed' },
      sleptAt: 5
    }
  })
  name('parser/explain')
  expect(events.at(-1)).toMatchObject({ session: { conversationName: 'parser/explain' } })
  expect(events.at(-1)).not.toHaveProperty('session.namingError')
  expect(events.at(-1)).toMatchObject({ session: { sleptAt: 5 } })
  sleep(undefined)
  expect(events.at(-1)).not.toHaveProperty('session.sleptAt')
  expect(lastName(events)).toBe('parser/explain')
})
