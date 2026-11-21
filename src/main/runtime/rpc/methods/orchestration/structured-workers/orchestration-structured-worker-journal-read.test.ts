import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { readStructuredWorkerJournal } from './orchestration-structured-worker-lifecycle'

const host = vi.hoisted(() => ({ items: new Array<unknown>() }))

vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => ({
      deps: {
        store: {
          getConversation: () =>
            agentSessionConversationView(
              agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-1' }))
            )
        }
      },
      history: async () => ({ ok: true, page: { items: host.items, hasOlder: false } })
    })
  })
)

const identity = {
  sessionId: 'session-1',
  processIncarnation: 'structured:session-1',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111'
}

it('pages a large chat journal through to its newest message', async () => {
  // Six 1,200-character blocks of 3-byte text: the journal and each 50-message page exceed 512 KiB.
  host.items = Array.from({ length: 200 }, (_, index): AgentJournalRenderItem => ({
    itemId: `i${index}`,
    revision: 1,
    sequence: index,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: Array.from({ length: 6 }, () => ({
        type: 'text' as const,
        text: index === 199 ? 'FINAL ANSWER' : '界'.repeat(1_200)
      }))
    }
  }))
  const served: string[] = []
  let cursor: string | undefined
  for (let reads = 0; reads < 30; reads++) {
    const page = await readStructuredWorkerJournal({
      identity,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude',
      limit: 50,
      ...(cursor === undefined ? {} : { cursor })
    })
    served.push(...page.transcript.messages.map((message) => message.id))
    if (!page.transcript.limited) {
      break
    }
    cursor = page.cursor
  }

  expect(served).toEqual(Array.from({ length: 200 }, (_, index) => `i${index}`))
})
