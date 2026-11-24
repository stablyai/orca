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
import type { ConversationChat, ConversationChatHost } from './external-conversation-chat'

// The real chat host and journal: a connector message whose start failed, then the conversation's next.
const KEY = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const CHAT: LinkableChat = {
  worktreeId: 'home',
  sessionId: SESSION,
  agent: 'codex',
  bot: { kind: 'bot', botId: 'bot-1' }
}
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** The host as the seam reads it; `send` may act first, as a person racing the delivery would. */
function chatHost(
  host: StructuredAgentSessionHost,
  before?: (attempt: number) => Promise<void>
): ConversationChatHost {
  const view: StructuredAgentSessionHost = Object.create(host)
  let attempt = 0
  view.send = async (...args) => {
    attempt += 1
    await before?.(attempt)
    return host.send(...args)
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
      // The Retry's turn starts before the message is sent again.
      retryTurn = deliveries.started(SESSION, Date.now() + 1)
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
