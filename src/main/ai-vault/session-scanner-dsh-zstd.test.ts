import type * as Zlib from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { constants, zstdCompressSync } from 'node:zlib'
import { decompressDshFrames } from './session-scanner-dsh-zstd'

async function* bytes(content: Buffer) {
  yield content
}
async function collect(source: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of source) {
    /* Drain the actual decoder. */
  }
}
afterEach(() => {
  vi.doUnmock('node:zlib')
  vi.resetModules()
})

it('validates a native Zstandard checksum on each appended frame', async () => {
  const frame = zstdCompressSync(Buffer.from('actual checksum validation\n'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 }
  })
  const corrupt = Buffer.from(frame)
  corrupt[corrupt.length - 1] ^= 1
  await expect(
    collect(decompressDshFrames(bytes(Buffer.concat([frame, corrupt]))))
  ).rejects.toThrow()
})

it('reports an unsupported older runtime without reading any source bytes', async () => {
  vi.doMock('node:zlib', async (importOriginal) => ({
    ...(await importOriginal<typeof Zlib>()),
    createZstdDecompress: undefined
  }))
  const { decompressDshFrames } = await import('./session-scanner-dsh-zstd')
  let read = false
  const source = (async function* () {
    read = true
    yield Buffer.alloc(4)
  })()
  await expect(collect(decompressDshFrames(source))).rejects.toThrow('host Node runtime')
  expect(read).toBe(false)
})
