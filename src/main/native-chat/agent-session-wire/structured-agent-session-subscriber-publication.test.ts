import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

it('reports every content publication to the journal hook, subscribed or not', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'hook-journal')
  })
  const published: string[] = []
  const subscribers = new AgentSessionSubscribers({
    onJournalPublished: (sessionId, published_journal) => {
      expect(published_journal).toBe(journal)
      published.push(sessionId)
    }
  })

  subscribers.publish(SESSION, journal)
  subscribers.snapshot(SESSION, journal, 1)

  expect(published).toEqual([SESSION, SESSION])
})

it('settles a session nobody is reading, from running to idle', async () => {
  // Never open a subscriber: status must publish independently of transcript readers.
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'unread-journal')
  })
  const statusFeed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        SESSION,
        {
          journal,
          params: {
            location: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'workspace-1',
              workspaceKind: 'git-worktree'
            },
            provider: 'codex'
          }
        }
      ]
    ]),
    getConversation: () => null,
    now: () => 1_000
  })
  const subscribers = new AgentSessionSubscribers({
    onJournalPublished: (sessionId, published) => statusFeed.publish(sessionId, published)
  })
  const statuses: AgentSessionStatusEvent[] = []
  statusFeed.subscribe({ id: 'session-list', emit: (event) => statuses.push(event) })
  const turn = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const

  await journal.appendItem(
    { ...turn, ordinal: 1 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    turn,
    { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  subscribers.publish(SESSION, journal)

  expect(statuses.at(-1)).toEqual({
    type: 'status',
    session: expect.objectContaining({ status: 'working', latestPrompt: 'write a poem' })
  })

  await journal.appendTombstone(turn, { fence: 1 })
  subscribers.publish(SESSION, journal)

  expect(statuses.at(-1)).toEqual({
    type: 'status',
    session: expect.objectContaining({ status: 'idle' })
  })
})

it('publishes background lifecycle without advancing the journal and carries its fence forward', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, 'background-journal')
  })
  let roster: AgentSessionBackgroundTaskState | null = null
  const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => roster })
  const events: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'subscriber-1',
    sessionId: SESSION,
    journal,
    fence: 1,
    emit: (event) => events.push(event)
  })
  const cursor = journal.cursor()

  const backgroundTasks: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
  }
  roster = backgroundTasks
  subscribers.republishBackgroundTasks(SESSION, 2)

  expect(journal.cursor()).toEqual(cursor)
  expect(events.at(-1)).toEqual({
    type: 'batch',
    sessionId: SESSION,
    batch: { cursor, items: [], removedItemIds: [], submissions: [] },
    fence: 2,
    hostNow: expect.any(Number),
    backgroundTasks
  })

  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'after-background-fence' },
    { kind: 'status', text: 'After background state' },
    { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  subscribers.publish(SESSION, journal)

  expect(events.at(-1)).toMatchObject({ type: 'batch', fence: 2 })
})

it('publishes latest turn activity without advancing or adding journal rows', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'activity-journal')
  })
  const subscribers = new AgentSessionSubscribers()
  const events: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'subscriber-1',
    sessionId: SESSION,
    journal,
    fence: 1,
    emit: (event) => events.push(event)
  })
  const cursor = journal.cursor()

  subscribers.publish(SESSION, journal, {
    turnId: 'turn-1',
    text: 'Inspecting the session wire'
  })

  expect(journal.cursor()).toEqual(cursor)
  expect(events.at(-1)).toEqual({
    type: 'batch',
    sessionId: SESSION,
    batch: { cursor, items: [], removedItemIds: [], submissions: [] },
    fence: 1,
    hostNow: expect.any(Number),
    activity: { turnId: 'turn-1', text: 'Inspecting the session wire' }
  })

  subscribers.close(SESSION, 'subscriber-1')
  subscribers.publish(SESSION, journal, null)
  subscribers.open({
    id: 'reconnected',
    sessionId: SESSION,
    journal,
    fence: 1,
    cursor,
    emit: (event) => events.push(event)
  })
  expect(journal.cursor()).toEqual(cursor)
  expect(events.at(-1)).toMatchObject({ activity: null })
})
