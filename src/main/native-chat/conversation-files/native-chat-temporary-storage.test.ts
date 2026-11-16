import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(async () => {
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

  it('removes an entry nothing changed in for the retention period, Git checkouts included', async () => {
    const root = await state()
    const folder = await prepareChatTemporaryFolder(root, key)
    await write(join(folder, 'checkout', '.git', 'HEAD'))
    await write(join(folder, 'checkout', 'node_modules', 'package', 'index.js'))
    await write(join(folder, 'in-use', 'deep', 'nested', 'output.bin'), NOW - DAY_MS)
    await write(join(folder, 'stale.log'))

    expect(
      (await inspectChatTemporaryStorage(root, held(key)))
        .map((row) => `${row.reason}:${row.path.slice(folder.length + 1)}`)
        .sort()
    ).toEqual(['idle:checkout', 'idle:stale.log', 'recent:in-use'])
    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 2, failed: 0 })
    expect(await exists(join(folder, 'checkout'))).toBe(false)
    expect(await exists(join(folder, 'stale.log'))).toBe(false)
    expect(await exists(join(folder, 'in-use', 'deep', 'nested', 'output.bin'))).toBe(true)
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
    await prepareChatTemporaryFolder(root, key)
    const foreign = join(chatTemporaryRoot(root), 'not-a-chat', 'stale.log')
    await write(foreign)
    expect(await sweepChatTemporaryStorage(root, held(key))).toEqual({ removed: 0, failed: 0 })
    expect(await exists(foreign)).toBe(true)
  })
})
