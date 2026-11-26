import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { connectorAskerImages } from './connector-asker-images'
import {
  connectorImageInspection,
  ConnectorImageProbes,
  storeConnectorImage
} from './connector-asker-stored-image'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryPreparation, DeliveryReceipts } from './external-conversation-delivery-receipts'
import type { ExternalConversationSeamDeps } from './external-conversation-host'
import { startConnectorConversation } from './external-conversation-start'
import type { ConnectorStartInput, Delivery } from './external-conversation-types'

const TARGET = { kind: 'bot' as const, botId: 'fixture-bot' }
const KEY = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const INPUT: ConnectorStartInput = {
  agent: 'codex',
  target: TARGET,
  prompt: '@bot',
  asker: {
    text: '@bot',
    userId: 'U1',
    role: 'owner',
    place: { kind: 'public_channel', id: 'C1' },
    earlierOwn: {
      messages: [
        {
          at: 1,
          text: 'Four screenshots',
          messageRef: 'slack:T1:C1:1.2:1.2',
          files: ['F1', 'F2', 'F3', 'F4'].map((id) => ({ id, name: 'shot.png', type: 'image/png' }))
        }
      ]
    },
    context: []
  }
}

it.each([10, 100])('retains no unadmitted uploads after %i retired starts', async (count) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-connector-staging-'))
  const attachments = new AgentSessionAttachmentStore(root, { hasSession: () => false })
  const db = new OrchestrationDb(':memory:')
  const deliveries = new ChatDeliveries(() => {})
  const signal = new AbortController().signal
  const chain = new ConversationChain(signal)
  const removal = Promise.withResolvers<void>()
  let cleaned = Promise.withResolvers<void>()
  let removed = 0
  const store: ExternalConversationSeamDeps['store'] = {
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => {},
    getRepos: () => []
  }
  const askerImages = connectorAskerImages({
    reader: () => async () => ({
      ok: true,
      value: {
        ok: true,
        result: { download: { url: 'https://fixture.invalid/image', ticket: 'fixture' } }
      }
    }),
    store: async (name, bytes, fileId, stagingSignal) => {
      const upload = await storeConnectorImage(attachments, name, bytes, fileId, stagingSignal)
      return {
        path: upload.path,
        discard: async () => {
          await removal.promise
          await upload.discard()
          if (++removed === 4) {
            cleaned.resolve()
          }
        }
      }
    },
    fetch: async () => new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10))
  })
  const receipts = new DeliveryReceipts(() => db)
  try {
    for (let delivery = 0; delivery < count; delivery++) {
      removed = 0
      cleaned = Promise.withResolvers<void>()
      const poll = new AbortController()
      const preparation = new DeliveryPreparation(poll.signal)
      const result = await startConnectorConversation(
        {
          store,
          receipts,
          askerImages,
          enqueue: (run: (signal: AbortSignal) => Promise<Delivery>) =>
            chain.enqueue(KEY.externalId, run),
          deliver: (chat, message) =>
            deliveries.deliver(undefined, KEY, chat, { ...message, preparation }),
          link: () => {}
        },
        {
          bots: {
            refusal: () => null,
            open: async (_, opening) => {
              if (!opening?.sessionId || !opening.beforeCreate) {
                throw new Error('The bot start did not prepare its delivery')
              }
              const { sessionId } = opening
              await opening.beforeCreate('codex')
              expect(await readdir(root)).toHaveLength(4)
              poll.abort('connectors_disabled')
              return { sessionId, agent: 'codex', worktreeId: 'fixture' }
            },
            workLinks: async () => []
          }
        },
        KEY,
        `delivery-${delivery}`,
        INPUT,
        preparation
      )
      expect(result.initial).toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
      if (delivery === 0) {
        expect(await receipts.recorded(KEY, `delivery-${delivery}`)).toBeNull()
        expect(await chain.after(KEY.externalId)).toEqual({ outcome: 'accepted' })
        expect(await readdir(root)).toHaveLength(4)
        removal.resolve()
      }
      await cleaned.promise
    }
    expect(await readdir(root)).toEqual([])
  } finally {
    removal.resolve()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([100, 1000])(
  'bounds unsettled image probes across %i retired deliveries',
  async (count) => {
    const storage = Promise.withResolvers<{ bytes: number; fileId: string }>()
    let reads = 0
    const probes = new ConnectorImageProbes(() => {
      reads++
      return storage.promise
    })
    const result = { bytes: 8, fileId: 'FSHOT' }
    try {
      for (let index = 0; index < count; index++) {
        const poll = new AbortController()
        const inspection = connectorImageInspection(undefined, poll.signal, { probes })
        const first = inspection.image('same-file')
        const second = inspection.image(`file-${index}`)
        // Let a free permit reach the filesystem before retiring its delivery.
        await new Promise<void>((resolve) => setImmediate(resolve))
        poll.abort()
        expect(await first).toBe('limit')
        expect(await second).toBe('limit')
      }
      expect(reads).toBe(8)
      const successor = connectorImageInspection(undefined, new AbortController().signal, {
        probes
      })
      const same = successor.image('same-file')
      const queued = successor.image('new-file')
      const delivery = new AbortController()
      const capacity = new AbortController()
      const shortWait = connectorImageInspection(undefined, delivery.signal, {
        probes,
        queueSignal: capacity.signal
      })
      const crowded = shortWait.image('other-file')
      capacity.abort()
      expect(await crowded).toBe('limit')
      expect(delivery.signal.aborted).toBe(false)
      expect(reads).toBe(8)
      storage.resolve(result)
      expect(await same).toEqual(result)
      expect(await queued).toEqual(result)
      expect(reads).toBe(9)
    } finally {
      storage.resolve(result)
    }
  }
)
