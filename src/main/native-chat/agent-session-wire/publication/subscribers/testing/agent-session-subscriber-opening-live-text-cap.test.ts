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

function textItem(text: string, revision = 1, sequence = 0): AgentJournalRenderItem {
  return {
    itemId: 'orca:text',
    revision,
    sequence,
    observedAt: revision - 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

it('counts live text an opening sends once, not again for the copy waiting behind it', async () => {
  // 3M characters each: the opening's text plus the waiting copy would pass 8 MiB together.
  const text = textItem('x'.repeat(3_000_000))
  const subscribers = new AgentSessionSubscribers({ readLiveText: () => [text] })
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
  const events: AgentSessionSubscribeEvent[] = []
  const ends: unknown[] = []
  const transport = Promise.withResolvers<void>()
  const close = subscribers.open({
    id: 'pane',
    sessionId: SESSION,
    journal,
    fence: 1,
    liveTextViewer: 'pane',
    liveTextShown: true,
    emit: (event) => events.push(event),
    end: (cause) => ends.push(cause),
    projectJournalEvent: async (_journal, event) => {
      await transport.promise
      return event
    }
  })
  const waiting = [textItem('1:'.padEnd(3_000_000, 'x'), 2, journal.cursor().sequence)]
  subscribers.publishLiveText(SESSION, journal, 1, waiting)
  try {
    transport.resolve()
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'batch',
          // Sent with the per-row bounds every live row gets.
          batch: expect.objectContaining({
            items: [expect.objectContaining({ itemId: text.itemId })]
          })
        })
      )
    )
    expect(ends).toHaveLength(0)
  } finally {
    transport.resolve()
    close()
  }
})
