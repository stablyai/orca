import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'

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
  let record: AgentSessionRecord = agentSessionRecordFixture()
  const sessions = new Map([['session', indexedStatusFeedSession({ journal })]])
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => record,
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
  return { feed, events, sessions, name }
}

function lastName(events: readonly AgentSessionStatusEvent[]): string | undefined {
  const event = events.at(-1)
  return event?.type === 'status' ? event.session.conversationName : undefined
}

it('publishes a held chat its saved name once, and not again for an unchanged record', async () => {
  const { feed, events, name } = await namedFeed()
  expect(lastName(events)).toBeUndefined()
  name('Explain the parser')
  expect(lastName(events)).toBe('Explain the parser')
  const count = events.length
  feed.publish('session')
  feed.publishConversationName('session')
  expect(events).toHaveLength(count)
})

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

it('keeps the name on the summary a closing chat retains', async () => {
  const { feed, events, name } = await namedFeed()
  name('Explain the parser')
  feed.close('session')
  expect(lastName(events)).toBe('Explain the parser')
})

it('publishes nothing for a chat this host never projected', async () => {
  const { feed, events } = await namedFeed()
  const count = events.length
  feed.publishConversationName('unknown-session')
  expect(events).toHaveLength(count)
})
