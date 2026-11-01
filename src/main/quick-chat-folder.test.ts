import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ensureQuickChatFolder } from './quick-chat-folder'
import type { Repo } from '../shared/repo-types'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-quick-chat-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('creates the folder lazily and recreates it if removed', async () => {
  const first = await ensureQuickChatFolder(root, [])
  expect((await stat(first.path)).isDirectory()).toBe(true)
  await rm(first.path, { recursive: true })
  expect(await ensureQuickChatFolder(root, [])).toEqual(first)
  expect((await stat(first.path)).isDirectory()).toBe(true)
})

it('never replaces a file at the path', async () => {
  const path = join(root, 'chats')
  await writeFile(path, 'keep this')
  await expect(ensureQuickChatFolder(root, [])).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('keep this')
})

it('reuses a local symlink alias and ignores an identical path on another host', async () => {
  const path = join(root, 'chats')
  await mkdir(path)
  const alias = join(root, 'alias')
  await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const repo: Repo = {
    id: 'local',
    path: alias,
    displayName: 'Renamed',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder'
  }
  const remote = { ...repo, id: 'remote', path, connectionId: 'ssh-other' }
  expect(await ensureQuickChatFolder(root, [remote, repo])).toEqual({
    path,
    canonicalPath: await realpath(path),
    repoId: 'local'
  })
  expect(repo.displayName).toBe('Renamed')
})
