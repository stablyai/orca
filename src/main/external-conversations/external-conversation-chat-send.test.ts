import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { CHAT_GONE_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { ChatDeliveries, type LinkableChat } from './external-conversation-chat-delivery'
import type { ConversationChat, ConversationChatHost } from './external-conversation-chat'
import { connectorAskerImages, type ConnectorImage } from './connector-asker-images'
import { storeConnectorImage } from './connector-asker-stored-image'
import { DeliveryPreparation } from './external-conversation-delivery-receipts'

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

async function holdImageDelivery(
  deliveries: ChatDeliveries,
  host: StructuredAgentSessionHost,
  preparation?: DeliveryPreparation
) {
  const preparing = Promise.withResolvers<void>()
  const staged = Promise.withResolvers<ConnectorImage[]>()
  const result = deliveries.deliver(chatHost(host), KEY, CHAT, {
    deliveryId: 'd-slack',
    text: '@bot',
    signal: new AbortController().signal,
    ...(preparation ? { preparation } : {}),
    asker: {
      userId: 'U1',
      role: 'owner',
      place: { kind: 'public_channel', id: 'C1' },
      context: [],
      text: '@bot'
    },
    askerImages: () => {
      preparing.resolve()
      return staged.promise
    }
  })
  await preparing.promise
  return { result, finish: (images: ConnectorImage[] = []) => staged.resolve(images) }
}

it('a request preparing its attachments does not own a concurrent local turn', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const { result, finish } = await holdImageDelivery(deliveries, rig.host)
  const pendingDuringPreparation = deliveries.pending(SESSION)
  const turnOrigin = deliveries.origin(SESSION, null)
  finish()
  await expect(result).resolves.toEqual({ outcome: 'accepted' })
  expect(pendingDuringPreparation).toBe(false)
  expect(turnOrigin).toBe('local')
  expect(deliveries.pending(SESSION)).toBe(true)
})

it.each(['old poll stops', 'cloud lease expires'])(
  'does not admit a prepared request after its %s',
  async (ending) => {
    rig = await createQueuedMessageTestRig({ starting: true })
    const deliveries = new ChatDeliveries(vi.fn())
    const poll = new AbortController()
    let left = 30_000
    const { result, finish } = await holdImageDelivery(
      deliveries,
      rig.host,
      new DeliveryPreparation(poll.signal, () => left)
    )
    const attachments = new AgentSessionAttachmentStore(join(rig.root, 'fixture-attachments'), {
      hasSession: () => true
    })
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const upload = await storeConnectorImage(attachments, 'shot.png', bytes, 'FSHOT', poll.signal)
    if (ending === 'old poll stops') {
      poll.abort()
    } else {
      left = 0
    }
    finish([{ ...upload, fileId: 'FSHOT', bytes: bytes.length }])
    await expect(result).resolves.toMatchObject({
      outcome: ending === 'cloud lease expires' ? 'expired' : 'refused'
    })
    expect(await (await journal()).reads.sendFingerprints()).toEqual([])
    expect(await readdir(attachments.rootDir)).toEqual([])
    expect(deliveries.pending(SESSION)).toBe(false)
  }
)

it('returns chat gone when its destination is deleted during attachment preparation', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const { result, finish } = await holdImageDelivery(deliveries, rig.host)
  let forgotten: boolean
  try {
    await rig.host.close(SESSION, 'evict')
    forgotten = await rig.store.forgetChat({
      chatId: SESSION,
      sessionIds: [SESSION],
      conversations: []
    })
  } finally {
    finish()
  }
  expect(forgotten).toBe(true)
  await expect(result).resolves.toEqual({ outcome: 'refused', reason: CHAT_GONE_REFUSAL })
})

it('delivers the request as text when an automatic attachment exceeds legacy Pi limits', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const fetch = vi.fn(async () => {
    const png = new Uint8Array(4 * 1024 * 1024)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return new Response(png)
  })
  const ref = 'slack:T1:C1:1.2:1.2'
  const result = await deliveries.deliver(
    chatHost(rig.host),
    KEY,
    { ...CHAT, agent: 'pi' },
    {
      deliveryId: 'd-pi',
      text: '@bot',
      signal: new AbortController().signal,
      asker: {
        userId: 'U1',
        role: 'owner',
        place: { kind: 'public_channel', id: 'C1' },
        context: [],
        text: '@bot',
        earlierOwn: {
          messages: [
            {
              at: 0,
              text: 'Earlier request',
              messageRef: ref,
              files: [{ id: 'FIMAGE', name: 'earlier.png', type: 'image/png' }]
            }
          ]
        }
      },
      askerImages: connectorAskerImages({
        reader: () => async () => ({
          ok: true,
          value: {
            ok: true,
            result: {
              download: {
                url: 'https://fixture.invalid/image',
                ticket: 'fixture',
                size: 4 * 1024 * 1024
              }
            }
          }
        }),
        fetch,
        store: async () => ({ path: '/attachments/image.png' })
      })
    }
  )
  expect(result).toEqual({ outcome: 'accepted' })
  expect((await lastSent()).body.blocks).toEqual([
    {
      type: 'text',
      text: expect.stringContaining(`orca slack read ${ref} --download FIMAGE`)
    }
  ])
  expect(fetch).not.toHaveBeenCalled()
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

it('names the native positions of earlier screenshots in their chronological context', async () => {
  rig = await createQueuedMessageTestRig({ starting: true })
  const deliveries = new ChatDeliveries(vi.fn())
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
  const store = new AgentSessionAttachmentStore(join(rig.root, 'fixture-attachments'), {
    hasSession: () => true
  })
  const request = {
    deliveryId: 'compare',
    text: 'Compare the before and after images',
    signal: new AbortController().signal,
    asker: {
      userId: 'U1',
      role: 'owner' as const,
      place: { kind: 'public_channel' as const, id: 'C1' },
      text: 'Compare the before and after images',
      context: [],
      earlierOwn: {
        messages: [
          {
            at: 1,
            text: 'Before',
            messageRef: 'slack:T1:C1:1.0:1.0',
            files: [{ id: 'FBEFORE', name: 'before.png', type: 'image/png' }]
          },
          {
            at: 2,
            text: 'After',
            messageRef: 'slack:T1:C1:2.0:2.0',
            files: [{ id: 'FAFTER', name: 'after.png', type: 'image/png' }]
          }
        ]
      }
    },
    askerImages: connectorAskerImages({
      reader:
        () =>
        async ({ fileId }) => ({
          ok: true,
          value: {
            ok: true,
            result: {
              download: {
                name: `${fileId}.png`,
                url: 'https://fixture.invalid/image',
                ticket: 'fixture'
              }
            }
          }
        }),
      fetch: async () => new Response(png),
      store: (name, bytes, fileId, signal) => storeConnectorImage(store, name, bytes, fileId, signal)
    })
  }
  expect(await deliveries.deliver(chatHost(rig.host), KEY, CHAT, request)).toEqual({
    outcome: 'accepted'
  })
  const { id, body } = await lastSent()
  const [text, ...attachments] = body.blocks
  const paths = attachments.flatMap((block) =>
    block.type === 'image-ref' && block.path ? [block.path] : []
  )
  expect(paths.map((path) => basename(path))).toEqual(['FAFTER.png', 'FBEFORE.png'])
  for (const path of paths) {
    expect(await readFile(path)).toEqual(Buffer.from(png))
  }
  expect(text).toMatchObject({
    type: 'text',
    text: expect.stringMatching(
      /file FBEFORE: before\.png, image\/png; attached to this turn as image 2\][\s\S]*file FAFTER: after\.png, image\/png; attached to this turn as image 1\]/
    )
  })
  const j = await journal()
  await j.settleStartFailure({
    startKey: id,
    clientMessageId: id,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'rejection' })
  })
  expect(await j.queuedMessages.returned()).toMatchObject([
    { card: { body: { blocks: body.blocks } } }
  ])
  for (const path of paths) {
    expect(await readFile(path)).toEqual(Buffer.from(png))
  }
})
