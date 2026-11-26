import { describe, expect, it, vi } from 'vitest'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { connectorAskerImages } from './connector-asker-images'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const conversation = { source: 'slack', externalId: 'T1:C1:1.1:U0BOT' }
const earlierImage: ConnectorAsker = {
  userId: 'U1',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C1' },
  text: '@bot',
  context: [],
  earlierOwn: {
    messages: [
      {
        at: 0,
        text: 'Screenshot',
        messageRef: 'slack:T1:C1:1.2:1.2',
        files: [{ id: 'FEARLIER', name: 'shot.png', type: 'image/png' }]
      }
    ]
  }
}

describe('connectorAskerImages', () => {
  it('keeps an image on the mention ahead of earlier request images', async () => {
    const read = vi.fn(async ({ fileId }: { fileId: string }) => ({
      ok: true as const,
      value: {
        ok: true as const,
        result: {
          download: {
            id: fileId,
            name: `${fileId}.png`,
            size: PNG.length,
            url: `https://cloud.example/files/${fileId}`,
            ticket: 'ticket'
          }
        }
      }
    }))
    const get = connectorAskerImages({
      read,
      store: async (name) => `/attachments/${name}`,
      fetch: async () => new Response(new Uint8Array(PNG))
    })
    const earlier = Array.from({ length: 4 }, (_, index) => ({
      text: 'Earlier screenshot.',
      at: index,
      messageRef: `slack:T1:C1:1.${index}:1.${index}`,
      files: [{ id: `F${index}`, name: 'image.png', type: 'image/png' }]
    }))
    await get({
      botId: 'bot-1',
      conversation,
      signal: new AbortController().signal,
      asker: {
        userId: 'U1',
        role: 'owner',
        place: { kind: 'public_channel', id: 'C1' },
        context: [],
        text: '@bot\n[image: current.png, file FCURRENT]',
        messageRef: 'slack:T1:C1:2.0:2.0',
        earlierOwn: { messages: earlier }
      }
    })
    expect(read.mock.calls.map(([request]) => (request as { fileId: string }).fileId)).toEqual([
      'FCURRENT',
      'F3',
      'F2',
      'F1'
    ])
  })

  it('stages an image from the request before a bare mention', async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      value: {
        ok: true as const,
        result: {
          download: {
            id: 'F0IMAGE',
            name: 'image.png',
            size: PNG.length,
            url: 'https://cloud.example/files/F0IMAGE',
            ticket: 'ticket'
          }
        }
      }
    }))
    const get = connectorAskerImages({
      read,
      store: async (name) => `/attachments/${name}`,
      fetch: async () => new Response(new Uint8Array(PNG))
    })
    const asker: ConnectorAsker = {
      userId: 'U1',
      role: 'owner',
      place: { kind: 'public_channel', id: 'C1' },
      text: '@Team UX Engineer redesign here',
      context: [],
      messageRef: 'slack:T1:C1:2.0:2.0',
      earlierOwn: {
        messages: [
          {
            text: 'Use this screenshot.',
            at: 0,
            messageRef: 'slack:T1:C1:1.0:1.0',
            files: [{ id: 'F0IMAGE', name: 'image.png', type: 'IMAGE/PNG', size: PNG.length }]
          }
        ]
      }
    }

    await expect(
      get({ botId: 'bot-1', conversation, asker, signal: new AbortController().signal })
    ).resolves.toEqual([{ path: '/attachments/image.png', fileId: 'F0IMAGE', bytes: PNG.length }])
    expect(read).toHaveBeenCalledWith(
      {
        botId: 'bot-1',
        ref: 'slack:T1:C1:1.0:1.0',
        fileId: 'F0IMAGE',
        conversation
      },
      expect.any(AbortSignal)
    )
  })

  it('does not repeat an earlier file carried by more than one message', async () => {
    const read = vi.fn(async ({ fileId }: { fileId: string }) => ({
      ok: true as const,
      value: {
        ok: true as const,
        result: {
          download: {
            id: fileId,
            name: `${fileId}.png`,
            size: PNG.length,
            url: 'https://cloud.example',
            ticket: 'ticket'
          }
        }
      }
    }))
    const get = connectorAskerImages({
      read,
      store: async (name) => `/attachments/${name}`,
      fetch: async () => new Response(new Uint8Array(PNG))
    })
    const staged = await get({
      botId: 'bot-1',
      conversation,
      signal: new AbortController().signal,
      asker: {
        userId: 'U1',
        role: 'owner',
        place: { kind: 'public_channel', id: 'C1' },
        text: '@bot',
        context: [],
        messageRef: 'slack:T1:C1:5.0:5.0',
        earlierOwn: {
          messages: Array.from({ length: 10 }, (_, at) => ({
            text: 'Same screenshot.',
            at,
            messageRef: `slack:T1:C1:${at}.0:${at}.0`,
            files: [
              { id: 'FSAME', name: 'image.png', type: 'image/png' },
              { id: `FDISTINCT${at}`, name: 'image.png', type: 'image/png' },
              { id: 'INVALID ID', name: 'image.png', type: 'image/png' }
            ]
          }))
        }
      }
    })
    expect(staged.map(({ fileId }) => fileId)).toEqual([
      'FSAME',
      'FDISTINCT9',
      'FDISTINCT8',
      'FDISTINCT7'
    ])
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('stops reading an earlier image whose bytes do not match a supported format', async () => {
    let chunks = 0
    let cancelled = false
    const store = vi.fn(async () => '/attachments/image.png')
    const get = connectorAskerImages({
      read: async () => ({
        ok: true,
        value: {
          ok: true,
          result: { download: { url: 'https://fixture.invalid/file', ticket: 'ticket' } }
        }
      }),
      store,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                chunks++
                controller.enqueue(new Uint8Array(12))
                if (chunks === 4) {
                  controller.close()
                }
              },
              cancel() {
                cancelled = true
              }
            },
            { highWaterMark: 0 }
          )
        )
    })
    const images = await get({
      botId: 'bot-1',
      conversation,
      signal: new AbortController().signal,
      asker: earlierImage
    })
    expect(images).toEqual([])
    expect(chunks).toBe(1)
    expect(cancelled).toBe(true)
    expect(store).not.toHaveBeenCalled()
  })

  it('stops waiting for an earlier-image budget when the delivery is cancelled', async () => {
    const readingBudget = Promise.withResolvers<void>()
    const abort = new AbortController()
    const read = vi.fn(async () => null)
    const get = connectorAskerImages({ read, store: async () => '/attachments/image.png' })
    const staged = get({
      botId: 'bot-1',
      conversation,
      signal: abort.signal,
      asker: earlierImage,
      earlierBudget: () => {
        readingBudget.resolve()
        return new Promise(() => {})
      }
    })
    await readingBudget.promise
    abort.abort()
    await expect(staged).resolves.toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
})
