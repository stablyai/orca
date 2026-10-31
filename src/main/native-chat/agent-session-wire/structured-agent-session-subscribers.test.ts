import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'
import { MAX_RETAINED_SESSION_ACTIVITIES } from './structured-agent-session-activity-retention'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import * as journalReducer from '../agent-session-journal/journal-reducer'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

it('renders history once per source for N/10N items and one/three readers', async () => {
  const render = vi.spyOn(journalReducer, 'renderJournalState')
  try {
    for (const size of [100, 1000]) {
      for (const readers of [1, 3]) {
        const journal = await journals.open({
          identity: {
            sessionId: SESSION,
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'codex',
            providerHandle: codexProviderHandle('thread-1')
          },
          stateDirectory: join(fixture.root, `${size}-${readers}`)
        })
        const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        const identity = (ordinal: number) => ({
          provider: 'codex' as const,
          threadId: 'thread-1',
          turnId: 'turn',
          ordinal
        })
        const body = (text: string) => ({
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text }]
        })
        for (let index = 0; index < size; index++) {
          await journal.appendItem(identity(index), body('initial'), options)
        }
        const projections = new StructuredAgentSessionJournalProjections()
        const events: AgentSessionSubscribeEvent[] = []
        const subscribers = new AgentSessionSubscribers({
          readCurrentWork: () => new StructuredAgentSessionCurrentWork(journal, 1, 0),
          onJournalPublished: () => {
            projections.read(journal, null)
          }
        })
        for (let index = 0; index < readers; index++) {
          subscribers.open({
            id: String(index),
            sessionId: SESSION,
            journal,
            fence: 1,
            boundedFrames: index === 1,
            emit: (event) => events.push(event)
          })
        }
        subscribers.publish(SESSION, journal)
        for (const text of ['streamed', 'newer']) {
          const prior = journal.snapshot()
          await journal.appendItem(identity(size - 1), body(text), options)
          render.mockClear()
          events.length = 0
          subscribers.publish(SESSION, journal)
          expect(render).toHaveBeenCalledTimes(1)
          const current = journal.snapshot()
          expect(current).not.toBe(prior)
          expect(current.items).toHaveLength(size)
          expect(current.items.at(-1)?.body).toEqual(body(text))
          expect(journal.publicRead().snapshot).toBe(current)
          expect(events.filter((event) => event.type === 'batch')).toHaveLength(readers)
          expect(
            events
              .flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
              .map((item) => item.body)
          ).toEqual(Array.from({ length: readers }, () => body(text)))
          expect(render).toHaveBeenCalledTimes(1)
        }
      }
    }
  } finally {
    render.mockRestore()
  }
})

it('bounds retained turn activity across session churn', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'activity-churn-journal')
  })
  const subscribers = new AgentSessionSubscribers()

  for (let index = 0; index < MAX_RETAINED_SESSION_ACTIVITIES + 4; index += 1) {
    subscribers.publish(`session-${index}`, journal, { turnId: `turn-${index}`, text: 'working' })
  }

  expect(subscribers.retainedActivityCountForTests).toBe(MAX_RETAINED_SESSION_ACTIVITIES)
})

it('publishes the current fence when a resumed cursor is already caught up', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'checkpoint-journal')
  })
  const events: AgentSessionSubscribeEvent[] = []

  new AgentSessionSubscribers().open({
    id: 'subscriber-1',
    sessionId: SESSION,
    journal,
    fence: 7,
    cursor: journal.cursor(),
    emit: (event) => events.push(event)
  })

  expect(events).toEqual([
    {
      type: 'batch',
      sessionId: SESSION,
      batch: {
        cursor: journal.cursor(),
        items: [],
        removedItemIds: [],
        submissions: []
      },
      fence: 7,
      hostNow: expect.any(Number),
      activity: null
    }
  ])
})

it('stamps the host clock once per published frame', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'clock-journal')
  })
  let now = 1_000
  let roster: AgentSessionBackgroundTaskState | null = null
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    now: () => (now += 1),
    readBackgroundTasks: () => roster
  })
  const emit = (event: AgentSessionSubscribeEvent): void => {
    events.push(event)
  }
  subscribers.open({ id: 'one', sessionId: SESSION, journal, fence: 1, emit })
  subscribers.open({ id: 'two', sessionId: SESSION, journal, fence: 1, emit })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'clocked' },
    { kind: 'status', text: 'Clocked' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  subscribers.publish(SESSION, journal)
  roster = {
    state: 'monitoring',
    tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
  }
  subscribers.republishBackgroundTasks(SESSION, 1)
  subscribers.snapshot(SESSION, journal, 1)

  expect(events.map((event) => ('hostNow' in event ? event.hostNow : null))).toEqual([
    1_001, 1_002,
    // Both subscribers of one publication read the same clock sample.
    1_003, 1_003, 1_004, 1_004, 1_005, 1_005
  ])
  expect(events.map((event) => event.type)).toEqual([
    'snapshot',
    'snapshot',
    'batch',
    'batch',
    'batch',
    'batch',
    'snapshot',
    'snapshot'
  ])
})

it('includes catalogs on reconnect and sends an idle checkpoint without journal work', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'catalog-journal')
  })
  let commands = [{ name: 'first', kind: 'skill' as const }]
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({ readCommands: () => commands })
  subscribers.open({
    id: 'one',
    sessionId: SESSION,
    journal,
    fence: 7,
    emit: (event) => events.push(event)
  })
  expect(events[0]).toMatchObject({ type: 'snapshot', commands })
  commands = [{ name: 'second', kind: 'skill' as const }]
  subscribers.publish(SESSION, journal)
  expect(events[1]).toEqual({
    type: 'batch',
    sessionId: SESSION,
    fence: 7,
    hostNow: expect.any(Number),
    commands,
    batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
  })
  subscribers.open({
    id: 'two',
    sessionId: SESSION,
    journal,
    cursor: journal.cursor(),
    fence: 7,
    emit: (event) => events.push(event)
  })
  expect(events[2]).toMatchObject({ type: 'batch', commands })
})
