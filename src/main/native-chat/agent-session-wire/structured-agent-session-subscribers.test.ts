import { BOUNDED_FRAME_ROW_BYTES } from './agent-session-bounded-frame-item'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { readPublishedQueuedMessages } from './structured-agent-session-queued-publication'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session/agent-session-background-task-wire'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { StructuredAgentSessionJournalProjections } from './structured-agent-session-status-journal-projection'
import { MAX_RETAINED_SESSION_ACTIVITIES } from './structured-agent-session-activity-retention'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import * as journalReducer from '../agent-session-journal/journal-reducer'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

it('keeps catch-up keyed and shares requested snapshots for N/10N items and one/three readers', async () => {
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
          expect(render).toHaveBeenCalledTimes(0)
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

it('fits a near-budget canonical history page and separate queue after desktop report enrichment', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'bounded-reports')
  })
  const refs = Array.from({ length: 40 }, (_, i) => ({
    messageId: `mail-${i}`,
    runId: `run-${i}-${'r'.repeat(500)}`,
    from: `external-${i}-${'s'.repeat(500)}`
  }))
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '' }],
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'mailbox',
        dispatchId: null,
        messages: refs
      }
    }
  }
  const text = 'x'.repeat(BOUNDED_FRAME_ROW_BYTES - Buffer.byteLength(JSON.stringify(body)) - 1024)
  body.blocks = [{ type: 'text', text }]
  const reports = refs.map((ref) => ({
    ...ref,
    mailbox: 'mailbox',
    report: {
      version: 1 as const,
      kind: 'command' as const,
      result: { type: 'exit' as const, code: 0 }
    }
  }))
  for (let i = 0; i < 8; i++) {
    const messageId = `history-report-${i}`
    await journal.queuedMessages.insert(
      { messageId, body },
      journal.mailDisplayReports.receipt(body, reports)
    )
    await journal.appendItem({ provider: 'orca', clientMessageId: `large-history-${i}` }, body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.queuedMessages.withdraw([messageId])
  }
  const queued: AgentJournalMessageItem = {
    ...body,
    blocks: [{ type: 'text', text: 'Waiting canonical message' }]
  }
  await journal.queuedMessages.insert(
    { messageId: 'waiting', body: queued },
    journal.mailDisplayReports.receipt(queued, reports)
  )
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    readQueuePublication: () => ({
      queuedMessages: readPublishedQueuedMessages(journal),
      queuePause: null,
      nextQueuedMessageId: null
    })
  })
  subscribers.open({
    id: 'phone',
    sessionId: SESSION,
    journal,
    fence: 1,
    boundedFrames: true,
    emit: (event) => events.push(event)
  })
  expect(events.length).toBeGreaterThanOrEqual(2)
  for (const frame of events) {
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
      MOBILE_BRIDGE_MAX_FRAME_BYTES
    )
  }
  const history = events.find((event) => event.type === 'snapshot')
  expect(history?.type === 'snapshot' && history.page.items).toHaveLength(8)
  expect(history?.type === 'snapshot' && history.page.items.map((item) => item.body)).toEqual(
    Array.from({ length: 8 }, () => body)
  )
  expect(history?.type === 'snapshot' && history.page).not.toHaveProperty('mailDisplayReports')
  const queue = events.find((event) => event.type === 'batch' && event.queuedMessages?.length)
  expect(queue?.type === 'batch' && queue.queuedMessages?.[0].body).toEqual(queued)
  expect(queue?.type === 'batch' && queue.batch.items).toEqual([])
})
