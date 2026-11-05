import { settleTestSubscriberDeliveries } from './agent-session-subscriber-test-support'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/structured-agent-session-reducer'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session/agent-session-background-task-wire'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

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
  await settleTestSubscriberDeliveries(subscribers)

  expect(statuses.at(-1)).toEqual({
    type: 'status',
    session: expect.objectContaining({ status: 'working', latestPrompt: 'write a poem' })
  })

  await journal.appendTombstone(turn, { fence: 1 })
  subscribers.publish(SESSION, journal)
  await settleTestSubscriberDeliveries(subscribers)

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
  await settleTestSubscriberDeliveries(subscribers)
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
  await settleTestSubscriberDeliveries(subscribers)

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
  await settleTestSubscriberDeliveries(subscribers)
  const cursor = journal.cursor()

  subscribers.publish(SESSION, journal, {
    turnId: 'turn-1',
    text: 'Inspecting the session wire'
  })
  await settleTestSubscriberDeliveries(subscribers)

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
  await settleTestSubscriberDeliveries(subscribers)
  subscribers.open({
    id: 'reconnected',
    sessionId: SESSION,
    journal,
    fence: 1,
    cursor,
    emit: (event) => events.push(event)
  })
  await settleTestSubscriberDeliveries(subscribers)
  expect(journal.cursor()).toEqual(cursor)
  expect(events.at(-1)).toMatchObject({ activity: null })
})

it('retains explicit activity through an ordinary held catch-up and later pending publications', async () => {
  const stateDirectory = join(fixture.root, 'held-activity')
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory
  })
  const database = await openTestJournalHostDatabase(stateDirectory)
  const subscribers = new AgentSessionSubscribers()
  let client = EMPTY_STRUCTURED_AGENT_SESSION
  subscribers.open({
    id: 'held-activity',
    sessionId: SESSION,
    journal,
    fence: 1,
    emit: (event) => {
      client = reduceStructuredAgentSession(client, { type: 'event', event })
    }
  })
  await settleTestSubscriberDeliveries(subscribers)
  const original = { turnId: 'turn-1', text: 'Original activity' }
  subscribers.publish(SESSION, journal, original)
  await settleTestSubscriberDeliveries(subscribers)
  expect(client.activity).toEqual(original)
  for (const activity of [null, { turnId: 'turn-1', text: 'Replacement activity' }]) {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `held-${activity?.text ?? 'clear'}` },
      { kind: 'status', text: 'Catch-up content' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const snapshot = database.snapshot.bind(database)
    const hold: typeof database.snapshot = async (view) => {
      const lease = await snapshot(view)
      entered()
      await held
      return lease
    }
    const spy = vi.spyOn(database, 'snapshot').mockImplementationOnce(hold)
    try {
      subscribers.publish(SESSION, journal)
      await reading
      subscribers.publish(SESSION, journal, activity)
      subscribers.publish(SESSION, journal)
      release()
      await settleTestSubscriberDeliveries(subscribers)
      expect(client.activity).toEqual(activity)
    } finally {
      release()
      spy.mockRestore()
    }
  }
  const recovered = { turnId: 'turn-2', text: 'Later legitimate activity' }
  subscribers.publish(SESSION, journal, recovered)
  await settleTestSubscriberDeliveries(subscribers)
  expect(client.activity).toEqual(recovered)
})
