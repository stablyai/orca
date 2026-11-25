import { expect, it } from 'vitest'
import { createCanonicalSessionResolver } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { botIdleItemsNote } from './bot-active-work'
import { createBotActiveWorkReader } from './bot-active-work-read'

it.each([750, 7_500])(
  'routes idle items by indexed chat reads among %i chats',
  async (chatCount) => {
    const idleItems = Array.from({ length: 12 }, (_, i) =>
      makeTestBotItem(i + 1, { chat: { id: `chat-${i}`, kind: 'chat', title: null } })
    )
    const records = new Map(
      Array.from({ length: chatCount }, (_, i) => {
        const id = `chat-${i}`
        return [
          id,
          agentSessionConversationView(
            agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: id }))
          )
        ]
      })
    )
    const work = await createBotActiveWorkReader()('bot-a', {
      items: async (status, limit) => ({
        items: status === 'working' ? idleItems.slice(0, limit) : [],
        counts: { working: idleItems.length }
      }),
      views: async (items) => [...items],
      workers: async () => []
    })
    let indexedReads = 0
    const sessionForChat = createCanonicalSessionResolver({
      getRecord: (id) => {
        indexedReads += 1
        return records.get(id) ?? null
      },
      listRecords: () => {
        throw new Error('idle notes must not enumerate chat records')
      }
    })
    const otherChat = `chat-${chatCount - 1}`
    expect(botIdleItemsNote(new Map(), otherChat, work.idle ?? [], sessionForChat)).toBeNull()
    expect(indexedReads).toBe(12)
  }
)
