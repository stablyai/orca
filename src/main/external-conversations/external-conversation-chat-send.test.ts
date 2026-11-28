import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { ChatDeliveries, type LinkableChat } from './external-conversation-chat-delivery'
import {
  chatPaneKey,
  type ConversationChat,
  type ConversationChatHost
} from './external-conversation-chat'
import { deliverToChat } from './external-conversation-chat-send'

// The real chat host and journal: a connector message whose start failed, then the conversation's next.
const KEY = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const CHAT: LinkableChat = {
  worktreeId: 'home',
  sessionId: SESSION,
  agent: 'codex',
  bot: { kind: 'bot', botId: 'bot-1' }
}
// Later than any send here: 2100-01-01.
const AFTER_EVERY_SEND = 4_102_444_800_000
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.useRealTimers()
  await rig?.dispose()
  rig = undefined
})

/** The host as the seam reads it; `send` may act first, as a person racing the delivery would, and
 *  `admitted` runs right after the send's admission callback, before the writer saves it. */
function chatHost(
  host: StructuredAgentSessionHost,
  before?: (attempt: number) => Promise<void>,
  admitted?: () => void
): ConversationChatHost {
  const view: StructuredAgentSessionHost = Object.create(host)
  let attempt = 0
  view.send = async (caller, mutation, ...rest) => {
    attempt += 1
    await before?.(attempt)
    const beforeRun = mutation.beforeRun
    const watched = admitted
      ? {
          ...mutation,
          beforeRun: () => {
            beforeRun?.()
            admitted()
          }
        }
      : mutation
    return host.send(caller, watched, ...rest)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real host is what runtimeChatHost hands the seam.
  const chat = view as unknown as ConversationChat
  return { current: () => chat, ensure: async () => chat, onChanged: () => () => {} }
}

async function journal() {
  return (await rig!.host.conversation(SESSION)).journal
}

/** A delivery its agent's launch refused as signed out: a returned card. */
async function failedStart(deliveries: ChatDeliveries, text: string): Promise<string> {
  const sent = await deliveries.deliver(chatHost(rig!.host), KEY, CHAT, {
    text,
    deliveryId: `d-${text}`,
    signal: new AbortController().signal
  })
  expect(sent).toEqual({ outcome: 'accepted' })
  const j = await journal()
  const [{ clientMessageId: id }] = await j.reads.sendFingerprints()
  // Its agent is still starting, and the launch then reports it isn't signed in.
  expect((await j.reads.submission(id))?.handedOverAt).toBeUndefined()
  await j.settleStartFailure({
    startKey: id,
    clientMessageId: id,
    fence: rig!.store.getRecord(SESSION)!.lease.runtimeFence,
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'rejection' })
  })
  expect((await j.queuedMessages.returned()).map(({ card }) => card.messageId)).toEqual([id])
  // Its failed start ended its turn.
  deliveries.origin(SESSION, null)
  return id
}

async function lastSent(): Promise<{ id: string; body: AgentJournalMessageItem }> {
  const j = await journal()
  const id = (await j.reads.sendFingerprints()).at(-1)!.clientMessageId
  const body = (await j.reads.historySourceItems([id]))[0]?.body
  if (body?.kind !== 'message') {
    throw new Error(`no message ${id}`)
  }
  return { id, body }
}

it('carries the failed message into the next one through send admission, once', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const root = await failedStart(deliveries, 'root')

  expect(
    await deliveries.deliver(chatHost(rig.host), KEY, CHAT, {
      text: 'next',
      deliveryId: 'd-next',
      signal: new AbortController().signal
    })
  ).toEqual({ outcome: 'accepted' })
  const next = await lastSent()
  expect(next.body.blocks.map((block) => (block.type === 'text' ? block.text : block))).toEqual([
    expect.stringMatching(/^\[Orca: sent .*\]\nroot$/),
    'next'
  ])
  expect(await (await journal()).queuedMessages.get(root)).toMatchObject({
    state: 'dispatched',
    consumedAs: next.id
  })
  expect(await (await journal()).queuedMessages.returned()).toEqual([])
})

it('a Retry racing the send leaves the delivery its own turn, not the Retry’s', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const root = await failedStart(deliveries, 'root')
  let retryTurn: string | undefined = 'unread'
  const chats = chatHost(rig.host, async (attempt) => {
    if (attempt === 1) {
      // The owner presses Retry on the card after the send read it.
      expect(await rig!.sendNow(root)).toMatchObject({ ok: true })
    } else {
      // The Retry's turn starts before the message is sent again (any time after the first attempt).
      retryTurn = deliveries.started(SESSION, AFTER_EVERY_SEND)
    }
  })

  expect(
    await deliveries.deliver(chats, KEY, CHAT, {
      text: 'next',
      deliveryId: 'd-next',
      signal: new AbortController().signal
    })
  ).toEqual({ outcome: 'accepted' })
  expect(retryTurn).toBeUndefined()
  // Sent alone: the card went with the Retry.
  expect((await lastSent()).body.carriedCards).toBeUndefined()
})

it('an abort after a refused attempt is refused, never read as sent', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const link = vi.fn()
  const deliveries = new ChatDeliveries(link)
  const root = await failedStart(deliveries, 'root')
  link.mockClear()
  const abort = new AbortController()
  const chats = chatHost(rig.host, async (attempt) => {
    if (attempt === 1) {
      expect(await rig!.sendNow(root)).toMatchObject({ ok: true })
    } else {
      abort.abort('connectors_disabled')
    }
  })

  const outcome = await deliveries.deliver(chats, KEY, CHAT, {
    text: 'next',
    deliveryId: 'd-next',
    signal: abort.signal
  })
  expect(outcome.outcome).toBe('refused')
  expect(link).not.toHaveBeenCalled()
  expect(deliveries.waiting(SESSION)).toBe(false)
})

// Another Orca bot's post that carries a person's failed message in: the operation the writer took,
// that consumed the card, is the one that lets the thread's other bots go on.
const NEIL = {
  source: 'slack',
  userId: 'U_NEIL',
  name: 'Neil',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C1' }
} as const
const FROM_DOCS = { ...NEIL, via: { userId: 'U_DOCS', name: 'Docs' } }

/** A chat of another bot in `thread` whose journal holds 12 of Docs' posts in a row, observed at
 *  `at`, no person after. */
function stoppedSibling(thread: string, at: number) {
  return siblingWith(
    thread,
    Array.from({ length: 12 }, () => at)
  )
}

/** A chat of another bot in `thread` whose journal holds Docs' posts, observed at `times`. */
function siblingWith(thread: string, times: readonly number[]) {
  const items = times.map((at, index) => ({
    itemId: `p${index}`,
    revision: 0,
    sequence: index + 1,
    observedAt: at,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      origin: 'connector' as const,
      asker: FROM_DOCS,
      blocks: [{ type: 'text' as const, text: 'over to you' }]
    }
  }))
  const chat = {
    deps: { store: { getConversation: () => ({ currentFence: 1 }) } },
    journalReads: async () => ({
      operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } })
    }),
    conversation: async () => ({ journal: { queuedMessages: { returned: async () => [] } } }),
    send: async (_caller: unknown, mutation: { beforeRun?: () => void }) => {
      mutation.beforeRun?.()
      return { ok: true, value: { clientMessageId: 'c1', queued: {} } }
    }
  }
  const link = {
    source: 'slack' as const,
    externalId: `${thread}:URANGER`,
    sessionId: 'chat-ranger',
    agent: 'claude' as const,
    paneKey: chatPaneKey('chat-ranger'),
    bot: { kind: 'bot' as const, botId: 'ranger' },
    createdAt: 1
  }
  const post = () =>
    deliverToChat(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only these of the chat.
      chat as unknown as ConversationChat,
      link,
      {
        text: 'over to you',
        asker: { ...FROM_DOCS, text: 'over to you', context: [] },
        deliveryId: `sibling-${Math.random()}`,
        signal: new AbortController().signal
      }
    )
  return { post }
}

/** Docs' post in `thread` carrying in the conversation's message from `author` that failed to start;
 *  `meanwhile` runs between that message's failed start and Docs' post. */
async function carriedIn(
  thread: string,
  author: typeof NEIL | typeof FROM_DOCS,
  meanwhile: () => Promise<void>,
  leadAdmitted?: () => void
) {
  rig = await createQueuedMessageTestRig({ starting: true })
  const key = { source: 'slack' as const, externalId: `${thread}:UBOT` }
  const deliveries = new ChatDeliveries(vi.fn())
  expect(
    await deliveries.deliver(chatHost(rig.host), key, CHAT, {
      text: 'earlier',
      asker: { ...author, text: 'earlier', context: [] },
      deliveryId: 'd-earlier',
      signal: new AbortController().signal
    })
  ).toEqual({ outcome: 'accepted' })
  const j = await journal()
  const [{ clientMessageId: card }] = await j.reads.sendFingerprints()
  await j.settleStartFailure({
    startKey: card,
    clientMessageId: card,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'rejection' })
  })
  deliveries.origin(SESSION, null)
  await meanwhile()
  expect(
    await deliveries.deliver(chatHost(rig.host, undefined, leadAdmitted), key, CHAT, {
      text: 'over to you',
      asker: { ...FROM_DOCS, text: 'over to you', context: [] },
      deliveryId: 'd-lead',
      signal: new AbortController().signal
    })
  ).toEqual({ outcome: 'accepted' })
  const lead = await lastSent()
  return { card, lead }
}

// The clock these deliveries run on, moving on as real time does: Neil's message just after AT, the
// sibling's wakes a minute later, Docs' post a minute after that.
const AT = Date.parse('2026-11-25T12:00:00.000Z')

/** After the failed message, as after a restart: the sibling's 12 wakes since stop it, and Docs'
 *  post comes later. */
async function siblingStoppedSince(thread: string) {
  vi.setSystemTime(AT + 60_000)
  const sibling = stoppedSibling(thread, AT + 60_000)
  expect(await sibling.post()).toMatchObject({ reason: 'bot_chain_limit' })
  vi.setSystemTime(AT + 120_000)
  return sibling
}

// Two real-journal deliveries and a failed start: slow on a loaded runner.
it("lets a stopped sibling go on once Docs' post carries Neil's failed message in", async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(AT)
  const thread = 'T1:C1:31.1'
  let sibling: Awaited<ReturnType<typeof siblingStoppedSince>> | undefined
  const { card, lead } = await carriedIn(thread, NEIL, async () => {
    sibling = await siblingStoppedSince(thread)
  })
  // One operation: it consumed Neil's card, carries his stamp and text first, then Docs' post.
  expect(await (await journal()).queuedMessages.get(card)).toMatchObject({ consumedAs: lead.id })
  expect(lead.body.carriedAskers).toEqual([expect.objectContaining({ userId: 'U_NEIL' })])
  expect(lead.body.carriedAskers![0]).not.toHaveProperty('via')
  expect(lead.body.asker).toMatchObject({ via: { name: 'Docs' } })
  expect(lead.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))).toEqual([
    expect.stringContaining('<<<\nearlier\n>>>'),
    expect.stringContaining('<<<\nover to you')
  ])
  expect(await sibling!.post()).toEqual({ outcome: 'accepted' })
}, 30_000)

// Two real-journal deliveries and a failed start: slow on a loaded runner.
it("keeps a sibling stopped when the carried message was another bot's post", async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(AT)
  const thread = 'T1:C1:32.1'
  let sibling: Awaited<ReturnType<typeof siblingStoppedSince>> | undefined
  const { card, lead } = await carriedIn(thread, FROM_DOCS, async () => {
    sibling = await siblingStoppedSince(thread)
  })
  expect(await (await journal()).queuedMessages.get(card)).toMatchObject({ consumedAs: lead.id })
  expect(await sibling!.post()).toMatchObject({ reason: 'bot_chain_limit' })
}, 30_000)

// Two real-journal deliveries and a failed start: slow on a loaded runner.
it("counts a sibling's wake from after Docs' post was admitted, before it was saved, as before", async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(AT)
  const thread = 'T1:C1:33.1'
  const { lead } = await carriedIn(
    thread,
    NEIL,
    async () => {
      vi.setSystemTime(AT + 60_000)
    },
    // The sibling's wake lands at AT + 90_000, after the admission callback; the writer saves later.
    () => vi.setSystemTime(AT + 120_000)
  )
  const submission = await (await journal()).reads.submission(lead.id)
  expect(submission?.submittedAt).toBeGreaterThanOrEqual(AT + 120_000)
  // Its 12th since Neil: the wake from before the save stays before it.
  const sibling = siblingWith(thread, [
    AT + 90_000,
    ...Array.from({ length: 11 }, () => AT + 180_000)
  ])
  expect(await sibling.post()).toEqual({ outcome: 'accepted' })
}, 30_000)
