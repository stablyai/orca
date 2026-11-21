import { describe, expect, it, vi } from 'vitest'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import {
  askerImageIds,
  connectorAskerImages,
  imageExtension,
  MAX_ASKER_IMAGE_BYTES
} from './connector-asker-images'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const conversation = { source: 'slack', externalId: 'T1:C1:1.1:U0BOT' }

const asker = (
  text: string,
  messageRef: string | undefined = 'slack:T1:C1:1.1:1.1'
): ConnectorAsker => ({
  userId: 'U1',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C1' },
  text,
  context: [],
  ...(messageRef ? { messageRef } : {})
})

describe('askerImageIds', () => {
  it('reads the images listed at the end of a request, and nothing typed higher up', () => {
    expect(
      askerImageIds(
        [
          'look at [image: fake.png, file F0FAKE] here',
          '[image: typed.png, file F0TYPED]',
          'and these',
          '',
          '[image: a.png, file F0A]',
          '[file: spec.pdf, file F0PDF]',
          '[file Slack does not show]',
          '[image: b, c.jpg, file F0B]'
        ].join('\n')
      )
    ).toEqual(['F0A', 'F0B'])
    expect(askerImageIds('no files here')).toEqual([])
    expect(
      askerImageIds(
        ['1', '2', '3', '4', '5'].map((n) => `[image: ${n}.png, file F${n}]`).join('\n')
      )
    ).toEqual(['F1', 'F2', 'F3', 'F4'])
  })
})

describe('imageExtension', () => {
  it('names an image by its first bytes, and nothing else as one', () => {
    expect(imageExtension(PNG)).toBe('.png')
    expect(imageExtension(JPG)).toBe('.jpg')
    expect(imageExtension(Buffer.from('GIF89a...'))).toBe('.gif')
    expect(imageExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('.webp')
    expect(imageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageExtension(Buffer.from('%PDF-1.7'))).toBeNull()
  })
})

describe('connectorAskerImages', () => {
  // The cloud's answer for each file id, and the bytes its link then serves.
  function images(
    files: Record<string, { bytes: Buffer; name?: string; size?: number } | 'refused'>
  ) {
    const stored: [string, number][] = []
    const read = vi.fn(async ({ fileId }: { fileId: string }) => {
      const file = files[fileId]
      return file === undefined || file === 'refused'
        ? ({ ok: true, value: { ok: false, refusal: 'not_found', message: 'gone' } } as const)
        : ({
            ok: true,
            value: {
              ok: true,
              result: {
                download: {
                  id: fileId,
                  name: file.name ?? `${fileId}.png`,
                  ...(file.size === undefined ? {} : { size: file.size }),
                  url: `https://cloud.example/files/${fileId}`,
                  ticket: `ticket-${fileId}`
                }
              }
            }
          } as const)
    })
    const fetched: [string, string | null][] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      fetched.push([url, new Headers(init?.headers).get('authorization')])
      const file = files[url.split('/').at(-1) ?? '']
      return file && file !== 'refused'
        ? new Response(new Uint8Array(file.bytes))
        : new Response(null, { status: 404 })
    })
    const get = connectorAskerImages({
      read,
      store: async (name, bytes) => {
        stored.push([name, bytes.length])
        return `/attachments/${name}`
      },
      fetch
    })
    return { get, read, stored, fetched }
  }
  const signal = new AbortController().signal

  it('saves each image under what its bytes are, with the ticket the cloud gave', async () => {
    const { get, read, stored, fetched } = images({
      F0A: { bytes: PNG, name: 'Screenshot 1.jpeg' },
      F0B: { bytes: JPG, name: 'photo' }
    })
    const paths = await get({
      botId: 'bot-1',
      conversation,
      asker: asker('look\n\n[image: Screenshot 1.jpeg, file F0A]\n[image: photo, file F0B]'),
      signal
    })
    expect(paths).toEqual(['/attachments/Screenshot 1.png', '/attachments/photo.jpg'])
    expect(stored).toEqual([
      ['Screenshot 1.png', PNG.length],
      ['photo.jpg', JPG.length]
    ])
    expect(read.mock.calls[0]?.[0]).toEqual({
      botId: 'bot-1',
      ref: 'slack:T1:C1:1.1:1.1',
      fileId: 'F0A',
      conversation
    })
    expect(fetched[0]).toEqual(['https://cloud.example/files/F0A', 'Bearer ticket-F0A'])
  })

  it('leaves out what it can’t have or can’t show, and keeps the rest', async () => {
    const { get, fetched } = images({
      F0GONE: 'refused',
      F0PDF: { bytes: Buffer.from('%PDF-1.7 not an image') },
      F0BIG: { bytes: PNG, size: MAX_ASKER_IMAGE_BYTES + 1 },
      F0OK: { bytes: PNG }
    })
    const text = ['F0GONE', 'F0PDF', 'F0BIG', 'F0OK']
      .map((id) => `[image: ${id}.png, file ${id}]`)
      .join('\n')
    expect(await get({ botId: 'bot-1', conversation, asker: asker(text), signal })).toEqual([
      '/attachments/F0OK.png'
    ])
    // One it was told is too large is never fetched.
    expect(fetched.map(([url]) => url)).not.toContain('https://cloud.example/files/F0BIG')
  })

  it('asks for nothing when the request lists no image, or names no message to read them from', async () => {
    const { get, read } = images({ F0A: { bytes: PNG } })
    expect(await get({ botId: 'b', conversation, asker: asker('hello'), signal })).toEqual([])
    expect(
      await get({
        botId: 'b',
        conversation,
        asker: asker('[image: a.png, file F0A]', ''),
        signal
      })
    ).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('hands back what it stored when a later write never finishes', async () => {
    const { read } = images({ F0A: { bytes: PNG }, F0B: { bytes: PNG } })
    let writes = 0
    const get = connectorAskerImages({
      read,
      store: (name) =>
        ++writes === 1 ? Promise.resolve(`/attachments/${name}`) : new Promise(() => {}),
      fetch: async () => new Response(new Uint8Array(PNG)),
      budgetMs: 50
    })
    expect(
      await get({
        botId: 'b',
        conversation,
        asker: asker('[image: a.png, file F0A]\n[image: b.png, file F0B]'),
        signal
      })
    ).toEqual(['/attachments/F0A.png'])
  })

  it('stops at its budget and hands back what it has', async () => {
    const stored: string[] = []
    const get = connectorAskerImages({
      read: () => new Promise(() => {}),
      store: async (name) => {
        stored.push(name)
        return name
      },
      budgetMs: 20
    })
    expect(
      await get({ botId: 'b', conversation, asker: asker('[image: a.png, file F0A]'), signal })
    ).toEqual([])
    expect(stored).toEqual([])
  })
})
