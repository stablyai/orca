import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { retiredCoordinatorChat } from './retired-coordinator-chat'

const chats = vi.hoisted(() => {
  const state: { host: unknown; conversations: Map<string, string> } = {
    host: null,
    conversations: new Map()
  }
  return state
})
vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => chats.host
  })
)

// No /clear successors here: each chat is its own lineage root.
vi.mock('../../../../orchestration/addressing/session-lineage/canonical-orca-session-id', () => ({
  createChatOrcaSessionIdResolver: () => (id: string) => id
}))

const OLD = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'

describe("a Run's coordinating chat that no one reads for now", () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only the bot list.
  const runtime = {
    bots: { list: () => [{ id: 'docs', folderWorkspaceId: 'home', chatSessionId: NEW }] }
  } as unknown as Pick<OrcaRuntimeService, 'bots'>
  const run = (coordinator: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only these fields.
    ({
      coordinator_orca_session_id: coordinator,
      coordinator_orca_session_id_generation: 0,
      consumer_generation: 0
    }) as unknown as RunRow

  beforeEach(() => {
    chats.conversations = new Map([
      [OLD, folderWorkspaceKey('home')],
      [NEW, folderWorkspaceKey('home')]
    ])
    chats.host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            chats.conversations.has(id)
              ? { sessionId: id, location: { workspaceId: chats.conversations.get(id) } }
              : null
        }
      }
    }
  })

  it("is a bot's Chat that /new replaced", () => {
    expect(retiredCoordinatorChat(runtime, run(OLD))).toBe(OLD)
  })

  it("is not the bot's current Chat", () => {
    expect(retiredCoordinatorChat(runtime, run(NEW))).toBeUndefined()
  })

  it('is a deleted chat', () => {
    chats.conversations.delete(OLD)
    expect(retiredCoordinatorChat(runtime, run(OLD))).toBe(OLD)
  })

  it('is unknown until the chats can be read', () => {
    chats.host = null
    expect(retiredCoordinatorChat(runtime, run(OLD))).toBeUndefined()
  })
})
