import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PluginImageCache, sha256Hex } from './plugin-image-cache'
import { pngImageBytes } from './plugin-image-test-fixture'

it('evicts the least recently read image when the disk cache would exceed capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-cache-'))
  try {
    const cache = new PluginImageCache(root, 256)
    const a = pngImageBytes(128, 128, 128, 1)
    const b = pngImageBytes(128, 128, 128, 2)
    const c = pngImageBytes(128, 128, 128, 3)
    await cache.put(a)
    await cache.put(b)
    expect((await cache.get(sha256Hex(a)))?.bytes).toEqual(a)
    await cache.put(c)

    const files = await readdir(root)
    expect(files.sort()).toEqual([sha256Hex(a), sha256Hex(c)].sort())
    const sizes = await Promise.all(files.map((file) => stat(join(root, file))))
    expect(sizes.reduce((total, file) => total + file.size, 0)).toBe(256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
