import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { ConversationEvent } from './external-conversation-events'
import { findLink } from './external-conversation-links'
import { writeChatLink, writeLinkFact } from './external-conversation-link-writes'
import { fakeLinkStore } from './external-conversation.test-fixture'
import type { ConversationKey } from './external-conversation-types'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'

const SESSION = 'session-1'

/** A bot chat whose turn was typed in Orca, with a question; a bot's Chat reads other mail the same. */
export function mailStartedBot(
  kind: 'bot' | 'bot-chat',
  capability = true,
  source: 'slack' | 'linear' = 'slack'
) {
  const paneKey = chatPaneKey(SESSION)
  const { store, folders } = fakeLinkStore()
  const home: { id: string; externalConversations?: unknown } = { id: 'bot-home' }
  folders.push(home)
  const chat = {
    worktreeId: 'folder:bot-home',
    sessionId: SESSION,
    agent: 'codex' as const,
    bot: { kind, botId: 'b1' }
  }
  let key: ConversationKey = { source, externalId: 'T1:D7:U9' }
  writeChatLink(store, key, chat)
  const linked = () => {
    const current = findLink(store, key)
    if (!current) {
      throw new Error('test chat has no conversation')
    }
    return current
  }
  const events: ConversationEvent[] = []
  let audience = capability
  let at = 500
  let forward: ((event: ConversationEvent) => void) | undefined
  let delivered = false
  let prompt: PendingPrompt | null = {
    kind: 'question',
    promptId: 'question-1',
    question: 'Which branch?',
    options: [{ id: '1', label: 'main' }]
  }
  let opener: AgentJournalRenderItem = {
    itemId: 'mail-1',
    revision: 0,
    sequence: 1,
    observedAt: 500,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Please decide.' }] }
  }
  const create = () =>
    new ChatTurns({
      readHookRow: () => ({
        paneKey,
        tabId: 'tab',
        worktreeId: 'folder:bot-home',
        connectionId: null,
        structuredHost: 'owned',
        state: 'working',
        prompt: '',
        agentType: 'codex',
        receivedAt: at,
        stateStartedAt: at
      }),
      pendingPrompt: () => prompt,
      chatTurnOrigin: () => (delivered ? 'delivery' : 'local'),
      chatTurnDelivered: () => delivered,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => [
        {
          url: at === 500 ? 'https://example.com/private' : 'https://example.com/public',
          title: at === 500 ? 'Private work' : 'Public work'
        }
      ],
      promptsAudience: () => audience,
      turnOpener: () => opener,
      keepAdoptedTurn: ({ link, workspace }, adoptedTurn) => {
        writeLinkFact(store, link, { adoptedTurn }, workspace)
      },
      linkedFor: linked,
      workerActivity: async () => null,
      emit: (event) => {
        events.push(event)
        forward?.(event)
      },
      setTimer: () => ({ cancel: () => {} }),
      now: () => 500
    })
  return {
    get link() {
      return linked().link
    },
    get linked() {
      return linked()
    },
    events,
    create,
    end: (lastAssistantMessage: string) => {
      const endedOpener = structuredClone(opener)
      return async () => ({
        lastAssistantMessage,
        opener: endedOpener
      })
    },
    forward: (listener: (event: ConversationEvent) => void) => {
      forward = listener
    },
    restart: () => {
      home.externalConversations = structuredClone(home.externalConversations)
      delivered = false
    },
    rebind: () => {
      key = { source: 'slack', externalId: 'T1:B:U9' }
      writeChatLink(store, key, chat)
    },
    publicTurn: () => {
      at = 900
      opener = {
        ...opener,
        itemId: 'public-opener',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [],
          connectorConversation: { source: key.source, externalId: key.externalId }
        }
      }
    },
    setCapability: (value: boolean) => {
      audience = value
    },
    joinDelivery: () => {
      delivered = true
    },
    answer: () => {
      prompt = null
    },
    relink: () => {
      opener = {
        ...opener,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [],
          connectorConversation: { source: 'slack', externalId: 'T1:OLD:1' }
        }
      }
    }
  }
}
