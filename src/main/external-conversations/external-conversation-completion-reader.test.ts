import { expect, it } from 'vitest'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session/view/agent-session-turn-completion-wire'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import {
  watchChatNews,
  type ChatNews,
  type ConversationChat,
  type ConversationChatHost
} from './external-conversation-chat'

const item = (
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem => ({
  itemId,
  sequence,
  body,
  revision: 0,
  observedAt: sequence
})
const journal: AgentJournalSnapshot = {
  sessionId: 'session-1',
  cursor: { epoch: 'epoch-1', sequence: 7 },
  submissions: [],
  items: [
    item('public-opener', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Public request' }],
      connectorConversation: { source: 'linear', externalId: 'org:issue-1' }
    }),
    item('public-turn-item', 2, {
      kind: 'turn',
      turnId: 'public-turn',
      userItemId: 'public-opener',
      state: 'completed',
      outcome: 'success'
    }),
    item('public-result', 3, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Public result' }]
    }),
    item('private-opener', 4, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Private request' }]
    }),
    item('private-turn-item', 5, {
      kind: 'turn',
      turnId: 'private-turn',
      userItemId: 'private-opener',
      state: 'completed',
      outcome: 'failure'
    }),
    item('private-result', 6, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Private result' }]
    }),
    item('private-failure', 7, {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        { kind: 'providerResponseFailed' },
        { surface: 'row', agentName: 'Agent' }
      )
    })
  ]
}

async function completionRead(cursor?: AgentJournalCursor) {
  let publish: ((event: AgentSessionTurnCompletionEvent) => void) | undefined
  const reader = {
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: structuredClone(journal), complete: true }),
      canonicalItemIds: async (itemIds: readonly string[]) =>
        itemIds.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    }),
    subscribeTurnCompletions: ({
      emit
    }: {
      emit: (event: AgentSessionTurnCompletionEvent) => void
    }) => {
      publish = emit
      return () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: watchChatNews calls only the host methods this reader implements.
  const chat = reader as unknown as ConversationChat
  const chats: ConversationChatHost = {
    current: () => chat,
    ensure: async () => chat,
    onChanged: () => () => {}
  }
  const events: ChatNews[] = []
  const release = watchChatNews(chats, (event) => events.push(event))
  publish?.({
    type: 'completion',
    completion: {
      sessionId: 'session-1',
      turnId: 'public-turn',
      outcome: 'success',
      completedAt: 3,
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:test',
        workspaceKind: 'folder'
      },
      ...(cursor ? { journalCursor: cursor } : {})
    }
  })
  release()
  const [event] = events
  if (event?.kind !== 'turn-ended') {
    throw new Error('Completion was not delivered')
  }
  return event.readTurn()
}

it.each([
  ['missing', undefined],
  ['mismatched epoch', { epoch: 'old-epoch', sequence: 3 }],
  ['ahead of the saved journal', { epoch: 'epoch-1', sequence: 8 }]
] as const)('withholds completion content with a %s cursor', async (_name, cursor) => {
  const result = await completionRead(cursor)
  expect(result.lastAssistantMessage).toBeUndefined()
  expect(result.failure).toBeUndefined()
  expect(result.opener).toBeFalsy()
})

it('reads a delayed public completion at its cursor despite a later private turn', async () => {
  const result = await completionRead({ epoch: 'epoch-1', sequence: 3 })
  expect(result.lastAssistantMessage).toBe('Public result')
  expect(result.opener?.itemId).toBe('public-opener')
  expect(result.failure).toBeUndefined()
})
