import { expect, it } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { botIdleItemsNote } from './bot-active-work'
import { createBotActiveWorkReader } from './bot-active-work-read'
import { createBotIdleItemChatRouter } from './bot-idle-item-chat'

const BOT = { folderWorkspaceId: 'designer', chatSessionId: 'home-chat' }
const chatId = (index: number): string => `chat-${String(index).padStart(6, '0')}`

function record(sessionId: string, successor?: string) {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return agentSessionConversationView({
    ...base,
    location: { ...base.location, workspaceId: folderWorkspaceKey(BOT.folderWorkspaceId) },
    ...(successor
      ? {
          conversationCommand: {
            command: 'clear',
            phase: 'committed',
            state: 'completed',
            callerKey: sessionId,
            operationId: 'clear',
            replacementSessionId: successor
          }
        }
      : {})
  })
}

function indexedRecords(records: Map<string, ReturnType<typeof record>>) {
  let reads = 0
  let revision = {}
  return {
    records: {
      getRecord: (id: string) => {
        reads += 1
        return records.get(id) ?? null
      },
      isSessionUnreadable: () => false,
      isSessionTabRetired: () => false,
      lineageRevision: () => revision,
      listRecords: (): never => {
        throw new Error('idle notes must not enumerate chat records')
      }
    },
    count: () => reads,
    lineageChanged: () => {
      revision = {}
    }
  }
}

it.each([750, 7_500])(
  'routes idle items by indexed chat reads among %i chats',
  async (chatCount) => {
    const idleItems = Array.from({ length: 12 }, (_, i) =>
      makeTestBotItem(i + 1, { chat: { id: chatId(i), kind: 'chat', title: null } })
    )
    const store = indexedRecords(
      new Map(Array.from({ length: chatCount }, (_, i) => [chatId(i), record(chatId(i))]))
    )
    const work = await createBotActiveWorkReader()('bot-a', {
      items: async (status, limit) => ({
        items: status === 'working' ? idleItems.slice(0, limit) : [],
        counts: { working: idleItems.length }
      }),
      views: async (items) => [...items],
      workers: async () => []
    })
    const route = createBotIdleItemChatRouter()
    const other = chatId(chatCount - 1)
    const idle = work.idle ?? []
    expect(
      botIdleItemsNote(new Map(), other, idle, route(BOT, store.records, other, idle))
    ).toBeNull()
    expect(store.count()).toBe(24)
  }
)

it.each([750, 7_500])('reuses an unchanged %i-step /clear lineage on later turns', (depth) => {
  const leaf = chatId(depth - 1)
  const records = new Map<string, ReturnType<typeof record>>(
    Array.from({ length: depth }, (_, i) => [
      chatId(i),
      record(chatId(i), i < depth - 1 ? chatId(i + 1) : undefined)
    ])
  )
  const store = indexedRecords(records)
  const idle = [{ chatId: chatId(0), number: 1, key: 'e1' }]
  const route = createBotIdleItemChatRouter()
  const memo = new Map<string, Map<number, string>>()
  botIdleItemsNote(memo, leaf, idle, route(BOT, store.records, leaf, idle))?.given()
  expect(store.count()).toBe(depth + 1)
  const initial = store.count()
  for (let turn = 0; turn < 10; turn += 1) {
    expect(botIdleItemsNote(memo, leaf, idle, route(BOT, store.records, leaf, idle))).toBeNull()
  }
  expect(store.count() - initial).toBe(10)

  const successor = chatId(depth)
  records.set(leaf, record(leaf, successor))
  records.set(successor, record(successor))
  store.lineageChanged()
  expect(
    botIdleItemsNote(memo, successor, idle, route(BOT, store.records, successor, idle))
  ).not.toBeNull()
})
