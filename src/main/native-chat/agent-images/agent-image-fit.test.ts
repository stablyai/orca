import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { PNG } from 'pngjs'
import { fitAgentImageFile } from './agent-image-fit'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

// The real 7.7MP codec fixture can exceed the default timeout on shared runners.
it('fits a retina screenshot into an immutable agent-readable copy while preserving its source and alpha', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-fit-'))
  roots.push(root)
  const source = join(root, 'retina.png')
  const image = new PNG({ width: 3456, height: 2234 })
  // Noise makes the original exceed the byte budget without a checked-in binary fixture.
  let value = 123456789
  for (let i = 0; i < image.data.length; i += 4) {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    image.data[i] = value & 255
    image.data[i + 1] = (value >>> 8) & 255
    image.data[i + 2] = (value >>> 16) & 255
    image.data[i + 3] = 128
  }
  const original = PNG.sync.write(image)
  expect(original.byteLength).toBeGreaterThan(5 * 1024 * 1024)
  await writeFile(source, original)
  const fitted = await fitAgentImageFile(source, join(root, 'copies'))
  expect(fitted).not.toBe(source)
  const bytes = await readFile(fitted)
  expect(bytes.byteLength).toBeLessThanOrEqual(3932160)
  const decoded = PNG.sync.read(bytes)
  expect(decoded.width).toBeLessThanOrEqual(2000)
  expect(decoded.height).toBeLessThanOrEqual(2000)
  expect(decoded.data[3]).toBe(128)
  expect((await readFile(source)).equals(original)).toBe(true)
  expect(await fitAgentImageFile(source, join(root, 'copies'))).toBe(fitted)
}, 30_000)

it('keeps already-small images and leaves sources beyond the safe decode budget to their provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-fit-'))
  roots.push(root)
  const source = join(root, 'small.png')
  const small = PNG.sync.write(new PNG({ width: 2, height: 2 }))
  await writeFile(source, small)
  expect(await fitAgentImageFile(source, join(root, 'copies'))).toBe(source)
  const oversized = Buffer.alloc(4 * 1024 * 1024)
  small.copy(oversized)
  oversized.writeUInt32BE(100_000, 16)
  oversized.writeUInt32BE(100_000, 20)
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29)
  await writeFile(source, oversized)
  expect(await fitAgentImageFile(source, join(root, 'copies'))).toBe(source)
})
