import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginImageCache } from './plugin-image-cache'

const renameHook = vi.hoisted((): { before: null | (() => Promise<void>) } => ({ before: null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await renameHook.before?.()
      return actual.rename(from, to)
    }
  }
})

const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function png(width: number, height: number): Buffer {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdr = [0, 0, 0, 13, ...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]
  return Buffer.from([...signature, ...ihdr, 0, 0, 0, 0])
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const roots: string[] = []
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-image-cache-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  renameHook.before = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginImageCache.put', () => {
  it('lets concurrent saves of the same image all succeed', async () => {
    const dir = await temp()
    const cache = new PluginImageCache(dir)
    const bytes = png(4, 4)
    const results = await Promise.all(Array.from({ length: 8 }, () => cache.put(bytes)))
    expect(results).toEqual(Array.from({ length: 8 }, () => sha(bytes)))
    expect(await readdir(dir)).toEqual([sha(bytes)])
    expect((await cache.get(sha(bytes)))?.bytes.equals(bytes)).toBe(true)
  })

  it('treats a rename failure as success when another writer already produced the file', async () => {
    const dir = await temp()
    const cache = new PluginImageCache(dir)
    const bytes = png(2, 2)
    renameHook.before = async () => {
      renameHook.before = null
      await fs.writeFile(join(dir, sha(bytes)), bytes)
      throw Object.assign(new Error('rename failed'), { code: 'EPERM' })
    }
    await expect(cache.put(bytes)).resolves.toBe(sha(bytes))
    expect(await readdir(dir)).toEqual([sha(bytes)])
  })

  it('still rejects when the rename fails and no valid file exists', async () => {
    const dir = await temp()
    const cache = new PluginImageCache(dir)
    renameHook.before = async () => {
      throw Object.assign(new Error('rename failed'), { code: 'ENOENT' })
    }
    await expect(cache.put(png(2, 2))).rejects.toThrow('rename failed')
    expect(await readdir(dir)).toEqual([])
  })
})
