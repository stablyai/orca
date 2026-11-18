import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { chatPaneKey, deliverToChat, type ConversationChat } from './external-conversation-chat'

const notes = vi.hoisted((): { sessionId: string | undefined; text: string }[] => [])
vi.mock('../bots/bot-chat-status-line', () => ({
  noteInChat: (sessionId: string | undefined, text: string) => notes.push({ sessionId, text })
}))

const NEIL = {
  source: 'slack',
  userId: 'U_NEIL',
  name: 'Neil',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C1' }
} as const
const fromDocs = { ...NEIL, via: { userId: 'U_DOCS', name: 'Docs' } }

let sequence = 0
function posted(asker: typeof NEIL | typeof fromDocs): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `m${sequence}`,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      asker,
      blocks: [{ type: 'text', text: 'hi' }]
    }
  }
}

/** A chat whose journal holds `items`; it takes every message, or refuses each with `refuses`. */
function chatWith(items: AgentJournalRenderItem[], refuses = false): ConversationChat {
  const chat = {
    deps: { store: { getConversation: () => ({ currentFence: 1 }) } },
    journalReads: async () => ({
      operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } })
    }),
    send: async (_caller: unknown, mutation: { beforeRun?: () => void }) => {
      if (refuses) {
        return { ok: false, refusal: { code: 'agent_session_conflict' } }
      }
      mutation.beforeRun?.()
      return { ok: true, value: { clientMessageId: 'c1', queued: {} } }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only these of the chat.
  return chat as unknown as ConversationChat
}

const linkOf = (bot: string) => ({
  source: 'slack' as const,
  externalId: `T1:C1:1700.1:U_${bot.toUpperCase()}`,
  sessionId: `chat-${bot}`,
  agent: 'claude' as const,
  paneKey: chatPaneKey(`chat-${bot}`),
  bot: { kind: 'bot' as const, botId: bot },
  createdAt: 1
})

let deliveries = 0
const deliver = (
  items: AgentJournalRenderItem[],
  options: {
    asker?: typeof NEIL | typeof fromDocs
    to?: string
    refuses?: boolean
    id?: string
  } = {}
) =>
  deliverToChat(chatWith(items, options.refuses), linkOf(options.to ?? 'ranger'), {
    text: 'over to you',
    asker: { ...(options.asker ?? fromDocs), text: 'over to you', context: [] },
    deliveryId: options.id ?? `d${(deliveries += 1)}`,
    signal: new AbortController().signal
  })

const posts = (count: number) => Array.from({ length: count }, () => posted(fromDocs))

describe("another Orca bot's Slack post", () => {
  beforeEach(() => {
    notes.length = 0
  })

  it('wakes a bot 12 times in a row, the 12th told to stop, and no 13th, saying why once', async () => {
    expect(await deliver(posts(11))).toEqual({ outcome: 'accepted' })
    const twelve = [posted(NEIL), ...posts(12)]
    expect(await deliver(twelve, { id: 'd-13th' })).toEqual({
      outcome: 'refused',
      reason: 'bot_chain_limit'
    })
    // The same post redelivered is the same refusal: one line.
    await deliver(twelve, { id: 'd-13th' })
    expect(notes.map((note) => note.sessionId)).toEqual(['chat-ranger'])
    // A person's message in between starts the count again.
    expect(await deliver([...posts(12), posted(NEIL)])).toEqual({ outcome: 'accepted' })
  })

  it('lets every bot in the thread go on once a chat takes a person message, never one it refused', async () => {
    const twelve = posts(12)
    expect(await deliver(twelve)).toMatchObject({ reason: 'bot_chain_limit' })
    // Neil writes to Docs in the same thread; Ranger's chat never sees it. Docs' chat refuses it first.
    await deliver([], { asker: NEIL, to: 'docs', refuses: true })
    expect(await deliver(twelve)).toMatchObject({ reason: 'bot_chain_limit' })
    await deliver([], { asker: NEIL, to: 'docs' })
    expect(await deliver(twelve)).toEqual({ outcome: 'accepted' })
  })
})
