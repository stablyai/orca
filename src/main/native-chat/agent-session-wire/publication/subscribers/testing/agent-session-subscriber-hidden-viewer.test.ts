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

it('sends a minimized window no live text, then its newest text once the window shows', async () => {
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
  const events: AgentSessionSubscribeEvent[] = []
  let hidden = true
  let shown = (): void => {}
  subscribers.open({
    id: 'pane',
    sessionId: SESSION,
    journal,
    fence: 1,
    emit: (event) => events.push(event),
    viewer: {
      hidden: () => hidden,
      subscribeShown: (listener) => {
        shown = listener
        return () => {}
      }
    }
  })
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  const opened = events.length
  text = 'The reply so far, and more'
  subscribers.publishLiveText(SESSION, journal, 1, read)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(events).toHaveLength(opened)
  // The newest text arrives with no publication at all while hidden, as when the host skips one.
  text = 'The reply so far, and more that arrived while minimized'

  hidden = false
  shown()
  await vi.waitFor(() => expect(events.length).toBe(opened + 1))
  expect(replyText(events.at(-1))).toBe(text)
})
