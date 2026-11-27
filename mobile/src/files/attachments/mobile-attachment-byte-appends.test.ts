import { describe, expect, it } from 'vitest'
import { agentSessionAttachmentByteAppends } from './mobile-attachment-byte-appends'

async function collect(pieces: Uint8Array[]): Promise<{ offset: number; contentBase64: string }[]> {
  async function* source(): AsyncGenerator<Uint8Array> {
    yield* pieces
  }
  const appends: { offset: number; contentBase64: string }[] = []
  for await (const append of agentSessionAttachmentByteAppends(source())) {
    appends.push(append)
  }
  return appends
}

describe('agentSessionAttachmentByteAppends', () => {
  it('regroups uneven reads into 384 KiB appends at byte offsets', async () => {
    const kib = 1024
    const appends = await collect([new Uint8Array(300 * kib), new Uint8Array(500 * kib)])
    expect(appends.map((append) => append.offset)).toEqual([0, 384 * kib, 768 * kib])
    expect(appends.map((append) => append.contentBase64.length)).toEqual([524288, 524288, 43692])
  })

  it('sends one empty append for an empty file', async () => {
    expect(await collect([])).toEqual([{ offset: 0, contentBase64: '' }])
  })

  it('keeps the bytes in order across pieces', async () => {
    const appends = await collect([new Uint8Array([1, 2]), new Uint8Array([3])])
    expect(appends).toEqual([{ offset: 0, contentBase64: 'AQID' }])
  })
})
