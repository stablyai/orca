import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { BOT_WAKE_LAST_LINE } from '../bots/bot-request-limits'
import { chatPaneKey, type ConversationChat } from './external-conversation-chat'
import { deliverToChat } from './external-conversation-chat-send'

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
// Another Slack app on the bot's Who can ask: let in, but never a person.
const lintApp = { ...NEIL, userId: 'U_LINT', name: 'Lint', role: 'member', app: true } as const
type Asker = typeof NEIL | typeof fromDocs | typeof lintApp

let sequence = 0
function posted(asker: Asker, observedAt = (sequence += 1)): AgentJournalRenderItem {
  return {
    itemId: `m${(sequence += 1)}`,
    revision: 0,
    sequence,
    observedAt,
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      asker,
      blocks: [{ type: 'text', text: 'hi' }]
    }
  }
}

// Each test's own Slack thread: a person's reply frees every bot in its thread for this process.
let thread = 0
const linkOf = (bot: string) => ({
  source: 'slack' as const,
  externalId: `T1:C1:${thread}.1:U_${bot.toUpperCase()}`,
  sessionId: `chat-${bot}`,
  agent: 'claude' as const,
  paneKey: chatPaneKey(`chat-${bot}`),
  bot: { kind: 'bot' as const, botId: bot },
  createdAt: 1
})

/** A message of this conversation that failed to start while the agent was signed out, which the
 *  conversation's next message carries in (external-conversation-returned-carry). */
const returnedCard = (to: string, asker: Asker) => ({
  card: {
    messageId: `card-${(sequence += 1)}`,
    fingerprint: 'f',
    state: 'returned',
    returnedRejection: { kind: 'notSignedIn' },
    body: {
      kind: 'message',
      role: 'user',
      origin: 'connector',
      asker,
      blocks: [{ type: 'text', text: 'earlier' }],
      connectorConversation: { source: 'slack', externalId: linkOf(to).externalId }
    }
  },
  editHeld: false,
  submittedAt: 1
})

type Send = 'accepts' | 'refuses' | 'superseded'
/** The turn texts each chat's writer was given, by session. */
const written: Record<string, string[]> = {}

/** A chat whose journal holds `items`. Each send answers with the next of `sends` (the last again
 *  after), and each read of the returned cards with the next of `returned` (none after). */
function chatWith(
  items: AgentJournalRenderItem[],
  {
    sends = ['accepts'],
    returned = [],
    onRead = () => {},
    onSend = () => {},
    afterRun = () => {},
    savedAt,
    onWindow = async () => {}
  }: {
    sends?: Send[]
    returned?: unknown[][]
    /** Runs as each read of the returned cards does, and before each send reaches the writer. */
    onRead?: (read: number) => void
    onSend?: (send: number) => void
    /** Runs once the admission callback has, before the writer saves the message. */
    afterRun?: () => void
    /** The writer's time for the message it saved; absent, the send is a queued one with none. */
    savedAt?: () => number
    /** Runs while the gate reads the chat's journal. */
    onWindow?: () => Promise<void>
  } = {}
): ConversationChat {
  let send = 0
  let read = 0
  const chat = {
    deps: { store: { getConversation: () => ({ currentFence: 1 }) } },
    journalReads: async () => ({
      operationWindow: async () => {
        await onWindow()
        return { complete: true, snapshot: { items, submissions: [] } }
      }
    }),
    conversation: async () => ({
      journal: {
        queuedMessages: {
          returned: async () => {
            onRead(read)
            return returned[read++] ?? []
          }
        }
      }
    }),
    send: async (
      _caller: unknown,
      mutation: {
        envelope: { sessionId: string }
        body: { blocks: { type: string; text?: string }[] }
        beforeRun?: () => void
      }
    ) => {
      onSend(send)
      const answer = sends[Math.min(send++, sends.length - 1)]
      if (answer === 'superseded') {
        return {
          ok: false,
          refusal: { code: 'agent_session_conflict', details: { reason: 'continuationSuperseded' } }
        }
      }
      if (answer === 'refuses') {
        return { ok: false, refusal: { code: 'agent_session_conflict' } }
      }
      mutation.beforeRun?.()
      afterRun()
      const text = mutation.body.blocks.map((block) => block.text ?? '').join('\n')
      ;(written[mutation.envelope.sessionId] ??= []).push(text)
      if (savedAt) {
        const submission = {
          clientMessageId: 'c1',
          dispatchState: 'accepted',
          submittedAt: savedAt()
        }
        return { ok: true, value: { clientMessageId: 'c1', submission } }
      }
      return { ok: true, value: { clientMessageId: 'c1', queued: {} } }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only these of the chat.
  return chat as unknown as ConversationChat
}

let deliveries = 0
const deliver = (
  items: AgentJournalRenderItem[],
  options: {
    asker?: Asker
    to?: string
    sends?: Send[]
    returned?: unknown[][]
    onRead?: (read: number) => void
    onSend?: (send: number) => void
    afterRun?: () => void
    savedAt?: () => number
    onWindow?: () => Promise<void>
    id?: string
    note?: string
  } = {}
) =>
  deliverToChat(chatWith(items, options), linkOf(options.to ?? 'ranger'), {
    text: 'over to you',
    asker: { ...(options.asker ?? fromDocs), text: 'over to you', context: [] },
    deliveryId: options.id ?? `d${(deliveries += 1)}`,
    signal: new AbortController().signal,
    ...(options.note ? { note: options.note } : {})
  })

const posts = (count: number) => Array.from({ length: count }, () => posted(fromDocs))

describe("another Orca bot's Slack post", () => {
  beforeEach(() => {
    notes.length = 0
    thread += 1
  })
  afterEach(() => {
    vi.useRealTimers()
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

  it('tells only the 12th wake, beside its own note, to stop handing on and end with the line', async () => {
    const note = 'Earlier in the thread: Neil asked for the changelog.'
    await deliver(posts(10), { note })
    await deliver(posts(11), { note })
    const [eleventh, twelfth] = written['chat-ranger']!.slice(-2)
    expect(eleventh).toContain(note)
    expect(eleventh).not.toContain(BOT_WAKE_LAST_LINE)
    expect(twelfth).toContain(note)
    expect(twelfth).toContain('without @mentioning any Orca bot')
    expect(twelfth).toContain(BOT_WAKE_LAST_LINE)
  })

  it('lets every bot in the thread go on once a chat takes a person message, never one it refused', async () => {
    const twelve = posts(12)
    expect(await deliver(twelve)).toMatchObject({ reason: 'bot_chain_limit' })
    // Neil writes to Docs in the same thread; Ranger's chat never sees it. Docs' chat refuses it first.
    await deliver([], { asker: NEIL, to: 'docs', sends: ['refuses'] })
    expect(await deliver(twelve)).toMatchObject({ reason: 'bot_chain_limit' })
    await deliver([], { asker: NEIL, to: 'docs' })
    expect(await deliver(twelve)).toEqual({ outcome: 'accepted' })
  })

  it("lets a bot's post through when a person replies to another bot while its journal is read", async () => {
    const twelve = posts(12)
    expect(
      await deliver(twelve, {
        onWindow: async () => {
          await deliver([], { asker: NEIL, to: 'docs' })
        }
      })
    ).toEqual({ outcome: 'accepted' })
  })

  it("never lets another Slack app's post free the thread, nor counts it as a bot's hop", async () => {
    const twelve = posts(12)
    // Docs' chat takes Lint's post; Ranger stays stopped.
    expect(await deliver([], { asker: lintApp, to: 'docs' })).toEqual({ outcome: 'accepted' })
    expect(await deliver(twelve)).toMatchObject({ reason: 'bot_chain_limit' })
    // In Ranger's own chat, Lint's post neither ends the count nor adds to it.
    expect(await deliver([...posts(6), posted(lintApp), ...posts(6)])).toMatchObject({
      reason: 'bot_chain_limit'
    })
    expect(await deliver([...posts(5), posted(lintApp), ...posts(6)])).toEqual({
      outcome: 'accepted'
    })
  })

  it("frees the thread when a bot's post carries in a person's message that failed to start", async () => {
    const twelve = posts(12)
    expect(await deliver(twelve, { to: 'docs' })).toMatchObject({ reason: 'bot_chain_limit' })
    // Neil's earlier message to Ranger, returned while Ranger was signed out, rides in with Docs' post.
    await deliver(posts(3), { returned: [[returnedCard('ranger', NEIL)]] })
    expect(await deliver(twelve, { to: 'docs' })).toEqual({ outcome: 'accepted' })
  })

  it('never frees the thread for a carried bot post, nor a carry its send refused or lost', async () => {
    const twelve = posts(12)
    const carry = (asker: Asker) => [[returnedCard('ranger', asker)]]
    await deliver(posts(3), { returned: carry(fromDocs) })
    await deliver(posts(3), { returned: carry(lintApp) })
    await deliver(posts(3), { returned: carry(NEIL), sends: ['refuses'] })
    // A racing Retry took Neil's card: the send that went carried none of it.
    await deliver(posts(3), { returned: [...carry(NEIL), []], sends: ['superseded', 'accepts'] })
    expect(await deliver(twelve, { to: 'docs' })).toMatchObject({ reason: 'bot_chain_limit' })
  })

  it("still counts the bot's post that carried a person's message in", async () => {
    const at = Date.parse('2026-11-25T12:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at)
    expect(await deliver(posts(3), { returned: [[returnedCard('ranger', NEIL)]] })).toEqual({
      outcome: 'accepted'
    })
    // That post, observed as its admission ran, then 11 more: the next is the 13th since Neil.
    const since = [...posts(12), posted(fromDocs, at)]
    for (let later = 1; later <= 11; later += 1) {
      since.push(posted(fromDocs, at + later))
    }
    expect(await deliver(since)).toMatchObject({ reason: 'bot_chain_limit' })
  })

  describe('when the writer takes a carried person message', () => {
    const at = Date.parse('2026-11-25T12:00:00.000Z')
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(at)
    })
    /** Docs' chat: old posts, `between` (a wake Docs took while Ranger's send was on its way),
     *  then `after` posts from once Ranger's writer took Neil's message on. */
    const docsJournal = (between: AgentJournalRenderItem, after: number) => [
      ...posts(12),
      between,
      ...Array.from({ length: after }, (_, index) => posted(fromDocs, at + 21 + index))
    ]

    it('counts a sibling wake from while its cards were read as before the reset', async () => {
      let between: AgentJournalRenderItem | undefined
      await deliver(posts(3), {
        returned: [[returnedCard('ranger', NEIL)]],
        // Docs takes a wake while Ranger's cards are being read; the writer takes Ranger's later.
        onRead: () => {
          vi.setSystemTime(at + 10)
          between = posted(fromDocs, at + 10)
        },
        onSend: () => vi.setSystemTime(at + 20)
      })
      // 11 after: this is Docs' 12th since Neil, told to stop, not refused as a 13th.
      expect(await deliver(docsJournal(between!, 11), { to: 'docs' })).toEqual({
        outcome: 'accepted'
      })
      expect(written['chat-docs']!.at(-1)).toContain(BOT_WAKE_LAST_LINE)
      expect(await deliver(docsJournal(between!, 12), { to: 'docs' })).toMatchObject({
        reason: 'bot_chain_limit'
      })
    })

    it('counts a sibling wake from after the admission callback, before the writer saved, as before', async () => {
      let between: AgentJournalRenderItem | undefined
      await deliver(posts(3), {
        returned: [[returnedCard('ranger', NEIL)]],
        // Docs takes a wake after Ranger's send was admitted, while its writer had yet to save it.
        afterRun: () => {
          between = posted(fromDocs, at + 10)
        },
        savedAt: () => at + 20
      })
      expect(await deliver(docsJournal(between!, 11), { to: 'docs' })).toEqual({
        outcome: 'accepted'
      })
      expect(written['chat-docs']!.at(-1)).toContain(BOT_WAKE_LAST_LINE)
    })

    it('counts a sibling wake from between a superseded attempt and the taken one as before', async () => {
      const between = posted(fromDocs, at + 10)
      const card = [returnedCard('ranger', NEIL)]
      await deliver(posts(3), {
        returned: [card, card],
        sends: ['superseded', 'accepts'],
        onSend: (attempt) => vi.setSystemTime(attempt === 0 ? at + 5 : at + 20)
      })
      expect(await deliver(docsJournal(between, 11), { to: 'docs' })).toEqual({
        outcome: 'accepted'
      })
      expect(written['chat-docs']!.at(-1)).toContain(BOT_WAKE_LAST_LINE)
    })
  })
})
