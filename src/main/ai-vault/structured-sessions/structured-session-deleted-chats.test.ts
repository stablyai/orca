import { expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { DeletedChats } from '../../native-chat/chat-deletion/deleted-chats'
import { projectStructuredAiVaultSessions } from './structured-session-ownership'
import { historySession, PROVIDER_SESSION } from './structured-session-ownership.test-support'

it("never lists a deleted chat's conversation in Session History, keeping every other row", () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection reads only `deps.store.conversationsKeyedBy` and `deletedChats`.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        conversationsKeyedBy: () => [],
        deletedChats: new DeletedChats([
          {
            chatId: 'chat-1',
            sessionIds: ['chat-1'],
            conversations: [{ provider: 'codex', providerSessionId: PROVIDER_SESSION }]
          }
        ])
      }
    }
  } as never)
  const kept = historySession({ id: 'local:codex:other', sessionId: 'other-thread' })

  const projected = projectStructuredAiVaultSessions(
    { sessions: [historySession(), kept], issues: [], scannedAt: '2026-11-21T00:00:00.000Z' },
    () => true
  )

  expect(projected.sessions.map((row) => row.sessionId)).toEqual(['other-thread'])
})
