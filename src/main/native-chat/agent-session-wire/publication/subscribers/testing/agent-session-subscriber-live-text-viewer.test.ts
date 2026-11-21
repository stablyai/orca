import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const replyText = (event: AgentSessionSubscribeEvent | undefined): string | undefined => {
  const body = event?.type === 'batch' ? event.batch.items[0]?.body : undefined
  return body?.kind === 'message' && body.blocks[0]?.type === 'text'
    ? body.blocks[0].text
    : undefined
}

async function chat() {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, SESSION)
  })
  let text = 'The reply so far'
  const read = (): readonly AgentJournalRenderItem[] => [
    {
      itemId: 'reply',
      revision: 1,
      sequence: journal.cursor().sequence,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
    }
  ]
  const subscribers = new AgentSessionSubscribers({
    readLiveText: () => read(),
    readSessionJournal: () => journal
  })
  const open = async (viewer?: { shown: boolean }) => {
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: viewer ? 'viewer' : 'older',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event),
      ...(viewer ? { liveTextViewer: 'connection:chat', liveTextShown: viewer.shown } : {})
    })
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
    return events
  }
  const publish = async (next: string) => {
    text = next
    subscribers.publishLiveText(SESSION, journal, 1, read)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { subscribers, open, publish, setText: (next: string) => (text = next) }
}

it('sends an older reader no live text, only the saves it got before', async () => {
  const { open, publish } = await chat()
  const events = await open()
  const opened = events.length
  await publish('The reply so far, and more')
  expect(events).toHaveLength(opened)
})

it('sends a hidden viewer no live text, then its newest text once it says it is shown', async () => {
  const { subscribers, open, publish, setText } = await chat()
  const events = await open({ shown: false })
  const opened = events.length
  await publish('The reply so far, and more')
  expect(events).toHaveLength(opened)
  // The newest text arrives with no publication at all while hidden.
  setText('The reply so far, and more that arrived while it was hidden')
  subscribers.setLiveTextShown(SESSION, 'connection:chat', true)
  await vi.waitFor(() => expect(events.length).toBe(opened + 1))
  expect(replyText(events.at(-1))).toBe(
    'The reply so far, and more that arrived while it was hidden'
  )

  subscribers.setLiveTextShown(SESSION, 'connection:chat', false)
  await publish('The reply so far, and more that arrived while it was hidden, and after')
  expect(events).toHaveLength(opened + 1)
})
