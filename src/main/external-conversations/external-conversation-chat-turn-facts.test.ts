import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatTurnFacts, type ConversationChat } from './external-conversation-chat'
import { fakeLinkStore, PANE, WORKTREE } from './external-conversation.test-fixture'

// STA-16952: a snapshot asks every linked chat whether its running turn is its conversation's, so
// an idle chat's answer must not read the links, and a claimed one reads only its own.

const link = (
  sessionId: string,
  paneKey: string,
  externalId: string
): ExternalConversationLink => ({
  source: 'slack',
  externalId,
  sessionId,
  agent: 'claude',
  paneKey,
  createdAt: 1
})
const C1 = 'slack:T1:C1:1.2'
const C2 = 'slack:T1:C2:9.9'

const continuation = (externalId: string): AgentJournalRenderItem => ({
  itemId: 'continue-1',
  revision: 1,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'continue' }],
    connectorClaim: {
      cutTurnId: 'turn-1',
      cutKind: 'restart',
      origin: [{ account: 'a', conversation: { source: 'slack', externalId }, deliveryId: 'd1' }]
    }
  }
})

function setup(openers: Record<string, AgentJournalRenderItem | null>) {
  const { store, put } = fakeLinkStore()
  put(WORKTREE, 'local', {
    externalConversations: [
      link('chat-1', PANE, C1),
      link('chat-2', 'tab-2:22222222-2222-4222-8222-222222222222', C2)
    ]
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: chatTurnFacts reads only publishedWork.
  const chat = {
    publishedWork: (sessionId: string) => ({ activeTurnOpener: openers[sessionId] ?? null })
  } as unknown as ConversationChat
  const facts = chatTurnFacts(
    { current: () => chat, ensure: async () => chat, onChanged: () => () => {} },
    store,
    () => false
  )
  const inventory = [
    vi.spyOn(store, 'getAllWorktreeMetaForHost'),
    vi.spyOn(store, 'getAllWorktreeMeta'),
    vi.spyOn(store, 'getFolderWorkspaces')
  ]
  return { facts, inventory }
}

it('answers an idle linked chat without reading any workspace’s links', () => {
  const { facts, inventory } = setup({ 'chat-1': null })

  expect(facts.delivered('chat-1')).toBe(false)
  expect(facts.delivered('chat-2')).toBe(false)
  inventory.forEach((read) => expect(read).not.toHaveBeenCalled())
})

it('counts a continuation’s turn only for the link whose requests it claims', () => {
  const { facts } = setup({ 'chat-1': continuation(C1), 'chat-2': continuation(C1) })

  expect(facts.delivered('chat-1')).toBe(true)
  // chat-2 is linked to C2 now; a claim on C1's requests is not its conversation's turn.
  expect(facts.delivered('chat-2')).toBe(false)
})
