import type * as FsPromises from 'node:fs/promises'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_TEMPORARY_RETENTION_MS,
  chatTemporaryRoot,
  inspectChatTemporaryStorage,
  prepareChatTemporaryFolder,
  sweepChatTemporaryStorage
} from './native-chat-temporary-storage'

const roots: string[] = []
const key = 'a'.repeat(32)
const otherKey = 'b'.repeat(32)
// Real change times cannot be set; a far-future clock makes every untouched file old.
const NOW = Date.UTC(2100, 0, 1)
const DAY_MS = 24 * 60 * 60_000

// Stands in for a writer that touches an entry while the sweep walks it.
const afterLstat = vi.hoisted(() => {
  const hook: { current: ((path: string) => Promise<void>) | null } = { current: null }
  return hook
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args)
      await afterLstat.current?.(String(args[0]))
      return info
    }
  }
})

afterEach(async () => {
  afterLstat.current = null
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function state(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-chat-temporary-test-'))
  roots.push(path)
  return path
}

async function write(path: string, changedAt?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'data')
  if (changedAt !== undefined) {
    await utimes(path, new Date(changedAt), new Date(changedAt))
  }
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false
  )

const held = (...keys: string[]) => ({ now: NOW, listHeld: () => new Set(keys) })

describe('chat temporary storage', () => {
  it('gives a chat the same folder on every launch', async () => {
    const root = await state()
    const first = await prepareChatTemporaryFolder(root, key)
    await write(join(first, 'environment', 'cache.bin'))
    const second = await prepareChatTemporaryFolder(root, key)
    expect(second).toBe(first)
    expect(await exists(join(second, 'environment', 'cache.bin'))).toBe(true)
    expect(await prepareChatTemporaryFolder(root, otherKey)).not.toBe(first)
  })

  it('removes an entry nothing changed in for the retention period unless it holds Git data', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    await write(join(folder, 'verification', 'repo', '.git', 'HEAD'))
    await write(join(folder, 'verification', 'repo', 'node_modules', 'package', 'index.js'))
    await write(join(folder, 'in-use', 'deep', 'nested', 'output.bin'), NOW - DAY_MS)
    await write(join(folder, 'stale.log'))

    expect(
      (await inspectChatTemporaryStorage(root, held(key)))
        .map((row) => `${row.reason}:${row.path.slice(folder.length + 1)}`)
        .sort()
    ).toEqual(['git:verification', 'idle:stale.log', 'recent:in-use'])
    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 1, failed: 0 })
    expect(await exists(join(folder, 'verification', 'repo', '.git', 'HEAD'))).toBe(true)
    expect(await exists(join(folder, 'stale.log'))).toBe(false)
    expect(await exists(join(folder, 'in-use', 'deep', 'nested', 'output.bin'))).toBe(true)
  })

  it('keeps every entry when the folder itself is a checkout', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    await write(join(folder, '.git', 'HEAD'))
    await write(join(folder, 'src', 'index.ts'))

    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 0, failed: 0 })
    expect(await exists(join(folder, 'src', 'index.ts'))).toBe(true)
  })

  it('keeps an idle entry written to while the sweep examines it, and removes the rest', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    const cache = join(folder, 'environment', 'cache')
    const stale = join(folder, 'stale')
    await write(join(cache, 'old.bin'))
    await write(join(stale, 'output.bin'))
    // Judged against the latest real change, so only what happens during the sweep comes after it.
    const tree = [dirname(cache), cache, join(cache, 'old.bin'), stale, join(stale, 'output.bin')]
    const cutoff = Math.max(
      ...(await Promise.all(tree.map(async (path) => (await lstat(path)).ctimeMs)))
    )
    // The cache folder has already been listed when its file is examined.
    afterLstat.current = async (path) => {
      if (path === join(cache, 'old.bin')) {
        afterLstat.current = null
        await write(join(cache, 'late.bin'), cutoff + DAY_MS)
      }
    }

    expect(
      await sweepChatTemporaryStorage(root, {
        ...held(key),
        now: cutoff + CHAT_TEMPORARY_RETENTION_MS
      })
    ).toEqual({ removed: 1, failed: 0 })
    expect(await exists(join(cache, 'late.bin'))).toBe(true)
    expect(await exists(stale)).toBe(false)
  })

  it('removes the whole folder of a chat that no longer exists, fresh data included', async () => {
    const root = await state()
    const kept = await prepareChatTemporaryFolder(root, key)
    const gone = await prepareChatTemporaryFolder(root, otherKey)
    await write(join(kept, 'build', 'fresh.bin'), NOW - DAY_MS)
    await write(join(gone, 'build', 'fresh.bin'), NOW - DAY_MS)

    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 1, failed: 0 })
    expect(await exists(gone)).toBe(false)
    expect(await exists(join(kept, 'build', 'fresh.bin'))).toBe(true)
  })

  it('only ages entries when the retained chats cannot be read', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    await write(join(folder, 'fresh', 'output.bin'), NOW - DAY_MS)
    await write(join(folder, 'stale', 'output.bin'))

    expect(await sweepChatTemporaryStorage(root, { now: NOW, listHeld: () => null })).toEqual({
      removed: 1,
      failed: 0
    })
    expect(await exists(join(folder, 'fresh', 'output.bin'))).toBe(true)
    expect(await exists(join(folder, 'stale'))).toBe(false)
  })

  it('does not examine an entry again before its last seen change can expire', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    const output = join(folder, 'environment', 'output.bin')
    const changedAt = NOW - DAY_MS
    await write(output, changedAt)
    const recentUntil = new Map<string, number>()
    const options = { ...held(key), recentUntil }

    expect(await sweepChatTemporaryStorage(root, options)).toEqual({ removed: 0, failed: 0 })
    await utimes(output, new Date(0), new Date(0))
    expect(await sweepChatTemporaryStorage(root, options)).toEqual({ removed: 0, failed: 0 })
    expect(
      await sweepChatTemporaryStorage(root, {
        ...options,
        now: changedAt + CHAT_TEMPORARY_RETENTION_MS + 1
      })
    ).toEqual({ removed: 1, failed: 0 })
  })

  it('never follows symlinks out of the temporary folder', async () => {
    const root = await state()
    const outside = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    await write(join(outside, 'keep.txt'), NOW - DAY_MS)
    await mkdir(join(folder, 'environment'))
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, join(folder, 'environment', 'external'), type)
    await symlink(outside, join(folder, 'linked'), type)

    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 2, failed: 0 })
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('data')
  })

  it('refuses a symlinked root and leaves entries Orca did not create', async () => {
    const linked = await state()
    const outside = await state()
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, chatTemporaryRoot(linked), type)
    await write(join(outside, key, 'stale.log'))
    await expect(prepareChatTemporaryFolder(linked, key)).rejects.toThrow('not a symlink')
    expect(await sweepChatTemporaryStorage(linked, held())).toEqual({ removed: 0, failed: 0 })
    expect(await exists(join(outside, key, 'stale.log'))).toBe(true)

    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    const foreign = join(chatTemporaryRoot(root), 'not-a-chat', 'stale.log')
    const unmarked = join(chatTemporaryRoot(root), 'c'.repeat(32), 'stale.log')
    const copied = join(chatTemporaryRoot(root), otherKey)
    await write(foreign)
    await write(unmarked)
    await cp(folder, copied, { recursive: true })
    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 0, failed: 0 })
    expect(await exists(foreign)).toBe(true)
    expect(await exists(unmarked)).toBe(true)
    expect(await exists(copied)).toBe(true)
  })
})
