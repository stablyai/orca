import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import { deletedCoordinatorChat } from './deleted-coordinator-chat'

const chats = vi.hoisted(() => {
  const state: { host: unknown; conversations: Set<string> } = {
    host: null,
    conversations: new Set()
  }
  return state
})
vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => chats.host })
)

const CHAT = '11111111-1111-4111-8111-111111111111'

describe("a Run's coordinating chat that was deleted", () => {
  const run = (coordinator: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only these fields.
    ({
      coordinator_orca_session_id: coordinator,
      coordinator_orca_session_id_generation: 0,
      consumer_generation: 0
    }) as unknown as RunRow

  beforeEach(() => {
    chats.conversations = new Set([CHAT])
    chats.host = {
      deps: {
        store: {
          getConversation: (id: string) => (chats.conversations.has(id) ? { sessionId: id } : null)
        }
      }
    }
  })

  it('is a chat whose record is gone', () => {
    chats.conversations.delete(CHAT)
    expect(deletedCoordinatorChat(run(CHAT))).toBe(CHAT)
  })

  it("is not a chat that still exists, a bot's thread chat or a replaced Chat included", () => {
    expect(deletedCoordinatorChat(run(CHAT))).toBeUndefined()
  })

  it('is unknown until the chats can be read', () => {
    chats.host = null
    chats.conversations.delete(CHAT)
    expect(deletedCoordinatorChat(run(CHAT))).toBeUndefined()
  })
})
