import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chatTemporaryRoot,
  inspectChatTemporaryStorage,
  prepareChatTemporaryFolder,
  sweepChatTemporaryStorage
} from './native-chat-temporary-storage'

const roots: string[] = []
const key = 'a'.repeat(32)
const NOW = Date.UTC(2100, 0, 1)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function state(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-chat-temporary-test-'))
  roots.push(path)
  return path
}
const absent = () => false

describe('managed chat temporary storage', () => {
  it('isolates launches and retains old data while the owning host is alive', async () => {
    const root = await state()
    const first = await prepareChatTemporaryFolder(root, key)
    const second = await prepareChatTemporaryFolder(root, key)
    expect(first).not.toBe(second)
    await writeFile(join(first, 'working.txt'), 'still running')
    expect(await sweepChatTemporaryStorage(root, { now: NOW })).toEqual({
      removed: 0,
      failed: 0
    })
    expect(await readFile(join(first, 'working.txt'), 'utf8')).toBe('still running')
    expect(
      (await inspectChatTemporaryStorage(root, { now: NOW })).map((row) => row.reason)
    ).toEqual(['active-owner', 'active-owner'])
  })

  it('reclaims only expired managed temporary data, retaining reports and provider history', async () => {
    const root = await state()
    const files = await prepareChatTemporaryFolder(root, key)
    await writeFile(join(files, 'generated.bin'), 'build output')
    const reports = join(root, 'chat-scratch', key)
    const provider = join(root, 'codex-accounts', 'account')
    await mkdir(reports, { recursive: true })
    await mkdir(provider, { recursive: true })
    await writeFile(join(reports, 'report.html'), 'keep report')
    await writeFile(join(provider, 'session.jsonl'), 'keep history')
    await expect(
      sweepChatTemporaryStorage(root, { now: NOW, isOwnerRunning: absent })
    ).resolves.toEqual({ removed: 1, failed: 0 })
    await expect(lstat(files)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(reports, 'report.html'), 'utf8')).toBe('keep report')
    expect(await readFile(join(provider, 'session.jsonl'), 'utf8')).toBe('keep history')
  })

  it('protects fresh data even in an old launch and rechecks owner liveness before removal', async () => {
    const root = await state()
    const files = await prepareChatTemporaryFolder(root, key)
    const now = NOW
    await writeFile(join(files, 'active.txt'), 'keep')
    const freshAt = new Date(now - 24 * 60 * 60_000)
    await utimes(join(files, 'active.txt'), freshAt, freshAt)
    expect(
      (await inspectChatTemporaryStorage(root, { now, isOwnerRunning: absent }))[0]?.reason
    ).toBe('recent')
    const oldAt = new Date('2000-01-01T00:00:00.000Z')
    await utimes(join(files, 'active.txt'), oldAt, oldAt)
    let observations = 0
    await expect(
      sweepChatTemporaryStorage(root, {
        now,
        isOwnerRunning: () => ++observations > 1
      })
    ).resolves.toEqual({ removed: 0, failed: 0 })
    expect(await readFile(join(files, 'active.txt'), 'utf8')).toBe('keep')
  })

  it('keeps temporary source checkouts, including bare Git repositories', async () => {
    const root = await state()
    const checkout = await prepareChatTemporaryFolder(root, key)
    const bare = await prepareChatTemporaryFolder(root, key)
    await writeFile(join(checkout, '.git'), 'gitdir: /a/worktree')
    await writeFile(join(bare, 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(bare, 'config'), '[core]')
    await mkdir(join(bare, 'objects'))
    const options = { now: NOW, isOwnerRunning: absent }
    expect((await inspectChatTemporaryStorage(root, options)).map((row) => row.reason)).toEqual([
      'git-data',
      'git-data'
    ])
    expect(await sweepChatTemporaryStorage(root, options)).toEqual({ removed: 0, failed: 0 })
  })

  it('never traverses nested symlinks or deletes their targets', async () => {
    const root = await state()
    const outside = await state()
    const files = await prepareChatTemporaryFolder(root, key)
    await writeFile(join(outside, 'keep.txt'), 'outside data')
    await symlink(
      outside,
      join(files, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(await sweepChatTemporaryStorage(root, { now: NOW, isOwnerRunning: absent })).toEqual({
      removed: 1,
      failed: 0
    })
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside data')
  })

  it('rejects symlink roots and unmanaged or invalid ownership markers', async () => {
    const root = await state()
    const outside = await state()
    await symlink(
      outside,
      chatTemporaryRoot(root),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(prepareChatTemporaryFolder(root, key)).rejects.toThrow('not a symlink')
    expect(await sweepChatTemporaryStorage(root)).toEqual({ removed: 0, failed: 0 })
    const managed = await state()
    const files = await prepareChatTemporaryFolder(managed, key)
    const marker = join(dirname(files), '.orca-temporary-storage.json')
    const original = JSON.parse(await readFile(marker, 'utf8'))
    await writeFile(marker, JSON.stringify({ ...original, folder: basename(files), pid: -1 }))
    expect(
      (await inspectChatTemporaryStorage(managed, { now: NOW, isOwnerRunning: absent }))[0]?.reason
    ).toBe('unmanaged')
    expect(await sweepChatTemporaryStorage(managed, { now: NOW, isOwnerRunning: absent })).toEqual({
      removed: 0,
      failed: 0
    })
  })
})
