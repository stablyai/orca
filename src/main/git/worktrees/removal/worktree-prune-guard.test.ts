// An unreadable worktree record must refuse the prune: `prune` deletes exactly the records this read exists to guard.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const gitExecFileAsync = vi.hoisted(() => vi.fn())
const fileOverrides = vi.hoisted(() => ({
  readdir: null as null | ((path: string) => Promise<string[]>),
  readFile: null as null | ((path: string) => Promise<string>)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (path: string) => fileOverrides.readdir?.(path) ?? actual.readdir(path),
    readFile: (path: string, encoding: 'utf8') =>
      fileOverrides.readFile?.(path) ?? actual.readFile(path, encoding)
  }
})
vi.mock('../../command-runner/git-exec-file', () => ({ gitExecFileAsync }))
vi.mock('../../command-runner/host-routing/wsl-drive-checkout-git-routing', () => ({
  pendingWslDriveCheckoutGitRouting: vi.fn()
}))
vi.mock('../../command-runner/host-routing/wsl-linked-worktree-git-routing', () => ({
  usesHostGitForWslLinkedWorktree: () => true
}))

import { pruneGitWorktrees, readWorktreeLinks } from './worktree-prune-guard'

const fileError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code })

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-prune-guard-'))
  gitExecFileAsync.mockReset()
  gitExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
  fileOverrides.readdir = null
  fileOverrides.readFile = null
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function addRecord(name: string, link: string): Promise<void> {
  await mkdir(join(root, name))
  await writeFile(join(root, name, 'gitdir'), link)
}

const pruneOptions = { cwd: '/repo', wslDistro: undefined } as unknown as Parameters<
  typeof pruneGitWorktrees
>[0]

it('a missing records folder is nothing to guard', async () => {
  await expect(readWorktreeLinks(join(root, 'worktrees'))).resolves.toEqual([])
})

it('a stray file in the records folder stays prunable', async () => {
  await writeFile(join(root, 'stray.txt'), 'not a record')
  await expect(readWorktreeLinks(root)).resolves.toEqual([])
})

it('a record whose gitdir read fails is not read as an absent record', async () => {
  await addRecord('foreign', 'W:/repo/.git')
  fileOverrides.readFile = () => Promise.reject(fileError('EIO'))
  await expect(readWorktreeLinks(root)).rejects.toThrow('EIO')
})

it('a failed listing refuses the prune and runs no git command', async () => {
  fileOverrides.readdir = () => Promise.reject(fileError('EIO'))
  gitExecFileAsync.mockResolvedValueOnce({ stdout: root, stderr: '' })
  await expect(pruneGitWorktrees(pruneOptions, 'win32')).rejects.toThrow('EIO')
  expect(gitExecFileAsync).toHaveBeenCalledTimes(1)
  expect(gitExecFileAsync).toHaveBeenCalledWith(['rev-parse', '--git-common-dir'], expect.anything())
})

it('the prune runs when every record reads', async () => {
  await addRecord('native', '.git/worktrees/native/.git')
  gitExecFileAsync.mockResolvedValueOnce({ stdout: root, stderr: '' })
  await pruneGitWorktrees(pruneOptions, 'win32')
  expect(gitExecFileAsync).toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
})
