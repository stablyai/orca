import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginImageCache } from './plugin-image-cache'

function fakePng(width: number, height: number, fillByte: number, totalBytes = 64): Buffer {
  const buf = Buffer.alloc(Math.max(40, totalBytes), fillByte)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.writeUInt32BE(0, 33)
  buf.write('IDAT', 37, 'ascii')
  return buf
}

const FIXED_NOW = 1_700_000_000_000

describe('PluginImageCache', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('prunes aged unreferenced images and stale temp files while keeping retained and fresh previews', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-image-cache-'))
    dirs.push(dir)
    const cache = new PluginImageCache(dir, { maxBytes: 1024 * 1024, minAgeMs: 60_000 })

    const retainedSha = await cache.put(fakePng(64, 64, 1, 100))
    const staleSha = await cache.put(fakePng(64, 64, 2, 100))
    const freshPreviewSha = await cache.put(fakePng(64, 64, 3, 100))
    expect(retainedSha && staleSha && freshPreviewSha).toBeTruthy()

    const oldTime = new Date(FIXED_NOW - 120_000)
    const freshTime = new Date(FIXED_NOW)
    await utimes(join(dir, retainedSha!), oldTime, oldTime)
    await utimes(join(dir, staleSha!), oldTime, oldTime)
    await utimes(join(dir, freshPreviewSha!), freshTime, freshTime)
    const staleTmp = join(dir, `${staleSha!}.orphan.tmp`)
    await writeFile(staleTmp, Buffer.from('partial'))
    await utimes(staleTmp, oldTime, oldTime)

    const removed = await cache.prune(new Set([retainedSha!]), { now: FIXED_NOW })
    expect(removed).toBe(1)
    expect(await cache.get(retainedSha!)).not.toBeNull()
    expect(await cache.get(freshPreviewSha!)).not.toBeNull()
    expect(await cache.get(staleSha!)).toBeNull()
  })

  it('evicts oldest unretained images first when over maxBytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-image-cache-'))
    dirs.push(dir)
    const cache = new PluginImageCache(dir, { maxBytes: 1024, minAgeMs: 60_000 })

    const shaA = await cache.put(fakePng(64, 64, 10, 100))
    const shaB = await cache.put(fakePng(64, 64, 11, 100))
    const shaC = await cache.put(fakePng(64, 64, 12, 100))
    await utimes(join(dir, shaA!), new Date(FIXED_NOW - 30_000), new Date(FIXED_NOW - 30_000))
    await utimes(join(dir, shaB!), new Date(FIXED_NOW - 20_000), new Date(FIXED_NOW - 20_000))
    await utimes(join(dir, shaC!), new Date(FIXED_NOW - 10_000), new Date(FIXED_NOW - 10_000))

    // All are younger than minAgeMs, but total (300B) > maxBytes (250B).
    // shaA is retained, so oldest unretained (shaB) must be evicted first.
    const removed = await cache.prune(new Set([shaA!]), { now: FIXED_NOW, maxBytes: 250 })
    expect(removed).toBe(1)
    expect(await cache.get(shaA!)).not.toBeNull()
    expect(await cache.get(shaB!)).toBeNull()
    expect(await cache.get(shaC!)).not.toBeNull()
  })
})
