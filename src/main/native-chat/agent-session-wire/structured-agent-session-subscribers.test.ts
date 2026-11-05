import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

import {
  fixture,
  SESSION,
  journals
} from './structured-agent-session-subscriber-contract-test-fixture'

it('delivers a revised message to current and bounded subscribers', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: join(fixture.root, 'revised-message')
  })
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const identity = { provider: 'codex' as const, threadId: 'thread-1', turnId: 'turn', ordinal: 0 }
  const body = (text: string) => ({
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text }]
  })
  await journal.appendItem(identity, body('initial'), options)
  const subscribers = new AgentSessionSubscribers()
  const frames: AgentSessionSubscribeEvent[][] = [[], []]
  frames.forEach((events, index) =>
    subscribers.open({
      id: String(index),
      sessionId: SESSION,
      journal,
      fence: 1,
      boundedFrames: index === 1,
      emit: (event) => events.push(event)
    })
  )
  for (const text of ['streamed', 'newer']) {
    await journal.appendItem(identity, body(text), options)
    subscribers.publish(SESSION, journal)
    await vi.waitFor(() => {
      for (const events of frames) {
        const items = events.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
        expect(items.at(-1)?.body).toEqual(body(text))
      }
    })
  }
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

  await vi.waitFor(() =>
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
  )
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
  await vi.waitFor(() =>
    expect(events[1]).toEqual({
      type: 'batch',
      sessionId: SESSION,
      fence: 7,
      hostNow: expect.any(Number),
      commands,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    })
  )
  subscribers.open({
    id: 'two',
    sessionId: SESSION,
    journal,
    cursor: journal.cursor(),
    fence: 7,
    emit: (event) => events.push(event)
  })
  await vi.waitFor(() => expect(events[2]).toMatchObject({ type: 'batch', commands }))
})
