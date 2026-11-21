import type * as FileSystem from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { prepareAgentImageFile } from './agent-image-fit'

const codec = vi.hoisted(() => {
  const source = Buffer.alloc(4 * 1024 * 1024)
  source.set([137, 80, 78, 71, 13, 10, 26, 10])
  source.writeUInt32BE(13, 8)
  source.write('IHDR', 12)
  const work = { resizes: 0, unchanged: 0 }
  const image = {
    width: 2000,
    height: 2000,
    resize(size: { width: number; height: number }) {
      work.resizes++
      if (this.width === size.width && this.height === size.height) {
        work.unchanged++
      }
      this.width = size.width
      this.height = size.height
      return this
    },
    encodePNG: async () => new Uint8Array([1, 2, 3])
  }
  return { source, work, image }
})
vi.mock('imagescript', () => ({
  Image: { decode: async () => codec.image },
  Animation: { decode: async () => ({ frames: [codec.image] }) }
}))
vi.mock('../../../shared/file-content/node-bounded-file-reader', () => ({
  readNodeFileWithinLimit: async () => ({ buffer: codec.source })
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  access: async () => {
    throw new Error('uncached')
  }
}))

it.each([10, 100])(
  'avoids redundant bitmap resizes across %i uncached fitting jobs',
  async (count) => {
    for (const size of [
      { width: 2000, height: 2000 },
      { width: 3456, height: 2234 }
    ]) {
      codec.source.writeUInt32BE(size.width, 16)
      codec.source.writeUInt32BE(size.height, 20)
      codec.work.resizes = 0
      codec.work.unchanged = 0
      for (let index = 0; index < count; index++) {
        codec.image.width = size.width
        codec.image.height = size.height
        const result = await prepareAgentImageFile('/shot.png', `/copies/${index}`)
        expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]))
      }
      expect(codec.work.unchanged).toBe(0)
      expect(codec.work.resizes).toBe(size.width === 2000 ? 0 : count)
      expect(codec.image.width).toBe(2000)
      expect(codec.image.height).toBe(size.width === 2000 ? 2000 : 1293)
    }
  }
)
