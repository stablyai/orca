// A connector snapshot asks every linked chat whether its turn is its conversation's. Idle chats
// have no turn opener, so they must not walk every link per chat: that cost O(links²) per connect
// (PR #46068 added the walk).
import { expect, it, vi } from 'vitest'
import type { AgentJournalConnectorClaim } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { chatTurnFacts, type ConversationChatHost } from './external-conversation-chat'
import type { ExternalConversationLinkStore } from './external-conversation-links'

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }

function linkedStore(count: number) {
  const externalConversations = Array.from({ length: count }, (_, i) => ({
    ...(i === 0 ? SLACK : { source: 'slack', externalId: `slack:T1:C1:${i}.0` }),
    paneKey: `tab-${i}:11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    sessionId: `chat-${i}`,
    agent: 'claude' as const,
    createdAt: 1
  }))
  const getFolderWorkspaces = vi.fn(() => [{ id: 'home', externalConversations }])
  const store: ExternalConversationLinkStore = {
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => undefined,
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces
  }
  return { store, getFolderWorkspaces }
}

function chatsWithOpener(
  sessionId: string,
  claim: AgentJournalConnectorClaim
): ConversationChatHost {
  const chat = {
    publishedWork: (id: string) =>
      id === sessionId
        ? { activeTurnOpener: { body: { kind: 'message', connectorClaim: claim } } }
        : { activeTurnOpener: undefined }
  }
  return {
    current: () => chat as unknown as ReturnType<ConversationChatHost['current']>,
    ensure: async () => null,
    onChanged: () => () => {}
  }
}

it('answers idle linked chats without reading any workspace, and a claimed one with one read', () => {
  const { store, getFolderWorkspaces } = linkedStore(50)
  const claim: AgentJournalConnectorClaim = {
    cutTurnId: 'item:t1',
    cutKind: 'restart',
    origin: [{ account: 'account-a', conversation: SLACK, deliveryId: 'd1' }]
  }
  const facts = chatTurnFacts(chatsWithOpener('chat-0', claim), store, () => false)

  for (let i = 1; i < 50; i++) {
    expect(facts.delivered(`chat-${i}`)).toBe(false)
  }
  expect(getFolderWorkspaces).toHaveBeenCalledTimes(0)

  expect(facts.delivered('chat-0')).toBe(true)
  expect(getFolderWorkspaces).toHaveBeenCalledTimes(1)
})
