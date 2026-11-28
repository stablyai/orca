import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { PI_UNSHRUNK_IMAGE_LIMITS, preparePiRpcPrompt } from '../pi/rpc/prompts/rpc-prompt'
import { connectorAskerImages, imageExtension } from './connector-asker-images'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const CONVERSATION = { source: 'slack', externalId: 'T1:C1:1.0:UBOT' }

let dir: string | undefined
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function asker(text: string, messageRef: string): ConnectorAsker {
  return {
    name: 'Alice',
    userId: 'U1',
    role: 'owner',
    place: { kind: 'public_channel', id: 'C1' },
    context: [],
    text,
    messageRef
  }
}

function streamFetch(byUrl: Record<string, Buffer>): typeof fetch {
  return async (input: string | URL | Request): Promise<Response> => {
    const bytes = byUrl[String(input)]
    if (!bytes) {
      return new Response(null, { status: 404 })
    }
    return new Response(new Uint8Array(bytes), { status: 200 })
  }
}

it('fetches images from carried follow-up messages using each follow-up messageRef', async () => {
  const seen: { ref: string; fileId: string }[] = []
  const fetchImages = connectorAskerImages({
    read: async ({ ref, fileId }) => {
      seen.push({ ref, fileId })
      return {
        ok: true,
        value: {
          ok: true,
          result: {
            download: {
              name: `${fileId}.png`,
              size: PNG_BYTES.byteLength,
              url: `https://files.test/${fileId}`,
              ticket: 't'
            }
          }
        }
      }
    },
    store: async (name) => `/store/${name}`,
    fetch: streamFetch({
      'https://files.test/F1': PNG_BYTES,
      'https://files.test/F2': PNG_BYTES
    })
  })

  const paths = await fetchImages({
    botId: 'bot-1',
    conversation: CONVERSATION,
    asker: asker('see first\n[image: one.png, file F1]', 'slack:T1:C1:1.0'),
    later: [{ asker: asker('and second\n[image: two.png, file F2]', 'slack:T1:C1:2.0') }],
    agent: 'claude',
    signal: new AbortController().signal
  })

  expect(seen).toEqual([
    { ref: 'slack:T1:C1:1.0', fileId: 'F1' },
    { ref: 'slack:T1:C1:2.0', fileId: 'F2' }
  ])
  expect(paths).toEqual(['/store/F1.png', '/store/F2.png'])
})

it('rejects non-RIFF WEBP and truncated GIF signatures that Pi rejects', () => {
  const fakeWebp = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const fakeGif = Buffer.from('GIF8xx')
  expect(imageExtension(fakeWebp)).toBeNull()
  expect(imageExtension(fakeGif)).toBeNull()
})

it('keeps auto-attached Pi images within Pi unshrunk limits so preparePiRpcPrompt accepts the turn', async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-asker-images-'))
  const halfTotal = Math.floor(PI_UNSHRUNK_IMAGE_LIMITS.image - 1024)
  const bigPng = Buffer.alloc(halfTotal)
  PNG_BYTES.copy(bigPng)
  const overPerImage = Buffer.alloc(PI_UNSHRUNK_IMAGE_LIMITS.image + 1024)
  PNG_BYTES.copy(overPerImage)

  const fetchImages = connectorAskerImages({
    read: async ({ fileId }) => ({
      ok: true,
      value: {
        ok: true,
        result: {
          download: {
            name: `${fileId}.png`,
            url: `https://files.test/${fileId}`,
            ticket: 't'
          }
        }
      }
    }),
    store: async (name, bytes) => {
      const target = join(dir!, name)
      await writeFile(target, bytes)
      return target
    },
    fetch: streamFetch({
      'https://files.test/F1': overPerImage,
      'https://files.test/F2': bigPng,
      'https://files.test/F3': bigPng,
      'https://files.test/F4': PNG_BYTES
    })
  })

  const paths = await fetchImages({
    botId: 'bot-1',
    conversation: CONVERSATION,
    asker: asker(
      'check these\n[image: huge.png, file F1]\n[image: a.png, file F2]\n[image: b.png, file F3]\n[image: c.png, file F4]',
      'slack:T1:C1:1.0'
    ),
    agent: 'pi',
    signal: new AbortController().signal
  })

  // F1 exceeds per-image limit; F3 would exceed total unshrunk limit; F2 + F4 fit.
  expect(paths).toEqual([join(dir, 'F2.png'), join(dir, 'F4.png')])
  const prompt = await preparePiRpcPrompt(
    {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'check these' },
        ...paths.map((path) => ({ type: 'image-ref' as const, path }))
      ]
    },
    false
  )
  expect(prompt.images).toHaveLength(2)
})
