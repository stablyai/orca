import { describe, expect, it, vi } from 'vitest'
import { incrementalPrefixReader } from './preview-raster-header-check'

describe('incrementalPrefixReader', () => {
  it('reads only the new tail of each wider probe, and nothing past EOF', async () => {
    const file = Uint8Array.from({ length: 100 }, (_, index) => index)
    const readRange = vi.fn(async (offset: number, length: number) =>
      file.subarray(offset, offset + length)
    )
    const readPrefix = incrementalPrefixReader(readRange)

    expect(await readPrefix(10)).toEqual(file.subarray(0, 10))
    expect(await readPrefix(64)).toEqual(file.subarray(0, 64))
    expect(await readPrefix(1024)).toEqual(file)
    expect(await readPrefix(4096)).toEqual(file)
    expect(readRange.mock.calls).toEqual([
      [0, 10],
      [10, 54],
      [64, 960]
    ])
  })
})
