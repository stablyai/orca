import { describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../src/shared/remote-runtime-memory-limits'
import type { RpcResponse } from '../transport/types'
import { collectMarkdownImageSrcs, readMarkdownImageSources } from './markdown-relative-image-srcs'

function reply(content: string, mimeType = 'image/png'): RpcResponse {
  return {
    id: 'preview',
    ok: true,
    _meta: { runtimeId: 'runtime-1' },
    result: { content, mimeType, isImage: true }
  }
}

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

const markdown = (...srcs: string[]) => srcs.map((src) => `![Image](${src})`).join('\n\n')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Markdown image resource limits', () => {
  it('runs at most two preview reads at once and admits replies in source order', async () => {
    const pending: ReturnType<typeof Promise.withResolvers<RpcResponse>>[] = []
    const client = {
      sendRequest: vi.fn(() => {
        const next = Promise.withResolvers<RpcResponse>()
        pending.push(next)
        return next.promise
      })
    }
    const reading = readMarkdownImageSources(
      client,
      'wt-1',
      'docs/a.md',
      markdown('a.png', 'b.png', 'c.png')
    )
    expect(pending).toHaveLength(2)
    pending[1]?.resolve(reply(png(8192, 4096)))
    await tick()
    expect(pending).toHaveLength(2)
    pending[0]?.resolve(reply(png(8192, 4096)))
    await tick()
    expect(pending).toHaveLength(3)
    pending[2]?.resolve(reply(png(1, 1)))
    expect(Object.keys(await reading)).toEqual(['a.png'])
  })

  it('charges map keys, headers and escaping within the existing JSON byte ceiling', async () => {
    const client = {
      sendRequest: vi.fn(async () => reply('A'.repeat(2 * 1024 * 1024), 'image/svg+xml'))
    }
    const sources = await readMarkdownImageSources(
      client,
      'wt-1',
      'docs/a.md',
      markdown('😀"a.svg', 'b.svg')
    )
    expect(Object.keys(sources)).toEqual(['😀"a.svg'])
    expect(Buffer.byteLength(JSON.stringify(sources))).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  })

  it('charges unknown raster headers the full existing raster pixel allowance', async () => {
    const client = { sendRequest: vi.fn(async () => reply('QUJD')) }
    expect(
      Object.keys(
        await readMarkdownImageSources(client, 'wt-1', 'a.md', markdown('a.png', 'b.png'))
      )
    ).toEqual(['a.png'])
  })

  it('keeps the first 24 distinct tokens, including code examples, under the read cap', async () => {
    const srcs = Array.from({ length: 25 }, (_, index) => `${index}.png`)
    const content =
      '`![Example](0.png)`\n\n```md\n![Example](1.png)\n```\n\n' + markdown(...srcs.slice(2))
    expect(collectMarkdownImageSrcs(content)).toEqual(srcs)
    const client = { sendRequest: vi.fn(async () => reply(png(1, 1))) }
    expect(Object.keys(await readMarkdownImageSources(client, 'wt-1', 'a.md', content))).toEqual(
      srcs.slice(0, 24)
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(24)
  })

  it('deduplicates exact tokens and preserves successful siblings after a slow refused read', async () => {
    const slow = Promise.withResolvers<RpcResponse>()
    const client = {
      sendRequest: vi.fn((_method: string, params: unknown) => {
        const path =
          typeof params === 'object' && params !== null && 'relativePath' in params
            ? params.relativePath
            : undefined
        return path === 'docs/b.png' ? slow.promise : Promise.resolve(reply(png(1, 1)))
      })
    }
    const reading = readMarkdownImageSources(
      client,
      'wt-1',
      'docs/a.md',
      markdown('a.png', 'a.png', 'b.png')
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
    slow.reject(new Error('refused'))
    expect(Object.keys(await reading)).toEqual(['a.png'])
    expect(client.sendRequest).toHaveBeenCalledWith('files.readPreview', {
      worktree: 'id:wt-1',
      relativePath: 'docs/a.png'
    })
  })
})
