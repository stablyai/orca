import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
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

it('enforces the disk capacity on the first read after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-cache-'))
  try {
    const old = pngImageBytes(128, 128, 128, 1)
    const recent = pngImageBytes(128, 128, 128, 2)
    const oldPath = join(root, sha256Hex(old))
    const recentPath = join(root, sha256Hex(recent))
    await writeFile(oldPath, old)
    await writeFile(recentPath, recent)
    await utimes(oldPath, 1, 1)
    await utimes(recentPath, 2, 2)
    const restarted = new PluginImageCache(root, 128)

    expect(await restarted.get(sha256Hex(old))).toBeNull()
    expect((await restarted.get(sha256Hex(recent)))?.bytes).toEqual(recent)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('can cache new artwork when the oldest entry cannot be removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-image-cache-'))
  try {
    const cache = new PluginImageCache(root, 256)
    const old = pngImageBytes(128, 128, 128, 1)
    const recent = pngImageBytes(128, 128, 128, 2)
    const next = pngImageBytes(128, 128, 128, 3)
    await cache.put(old)
    await cache.put(recent)
    const blocked = join(root, sha256Hex(old))
    await rm(blocked)
    await mkdir(blocked)

    await cache.put(next)
    expect((await cache.get(sha256Hex(next)))?.bytes).toEqual(next)
    expect(await cache.get(sha256Hex(recent))).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
