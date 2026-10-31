import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import { ensureQuickChatFolder } from './quick-chat-folder'
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
it.each([10, 100])(
  'does linear canonical work for %s local projects without probing foreign paths',
  async (n) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quick-chat-perf-'))
    roots.push(root)
    const path = join(root, 'chats')
    const locals: Repo[] = Array.from({ length: n }, (_, index) => ({
      id: String(index),
      path: index ? join(root, `p${index}`) : path,
      displayName: 'Kept',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder'
    }))
    const foreign = Array.from({ length: n * 10 }, (_, index) => ({
      ...locals[0],
      id: `foreign${index}`,
      path: `/foreign/${index}`,
      executionHostId: 'runtime:peer'
    }))
    vi.mocked(realpath).mockClear()
    expect(await ensureQuickChatFolder(root, [...locals, ...foreign])).toEqual({
      path,
      repoId: '0'
    })
    expect(realpath).toHaveBeenCalledTimes(n + 1)
    expect(vi.mocked(realpath).mock.calls.every(([path]) => String(path).startsWith(root))).toBe(
      true
    )
  }
)
it('validates every overlapping action rather than sharing an earlier directory verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-quick-chat-validation-'))
  roots.push(root)
  const { path } = await ensureQuickChatFolder(root, [])
  await rm(path, { recursive: true })
  await writeFile(path, 'preserve')
  await expect(ensureQuickChatFolder(root, [])).rejects.toThrow()
  expect((await stat(path)).isFile()).toBe(true)
  await rm(path)
  await mkdir(path)
  await expect(ensureQuickChatFolder(root, [])).resolves.toEqual({ path, repoId: undefined })
})
