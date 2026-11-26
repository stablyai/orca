import { describe, expect, it, vi } from 'vitest'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { connectorAskerImages } from './connector-asker-images'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const conversation = { source: 'slack', externalId: 'T1:C1:1.1:U0BOT' }

describe('connectorAskerImages', () => {
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
            files: [{ id: 'F0IMAGE', name: 'image.png', type: 'image/png', size: PNG.length }]
          }
        ]
      }
    }

    await expect(
      get({ botId: 'bot-1', conversation, asker, signal: new AbortController().signal })
    ).resolves.toEqual(['/attachments/image.png'])
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
})
