import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../command-runner/git-exec-file', () => ({
  gitExecFileAsync: async (args: string[], options: { cwd: string }) =>
    promisify(execFile)('git', args, { cwd: options.cwd })
}))

import { _resetRemoteNameListingCache, isRemoteListedAbsent, listCachedRemoteNames } from './remote-name-listing'

const exec = promisify(execFile)
let root: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-branch-remote-'))
  _resetRemoteNameListingCache()
})

afterEach(async () => {
  _resetRemoteNameListingCache()
  await rm(root, { recursive: true, force: true })
})

it.each(['folder', 'linked worktree'])('refreshes branch-conditional remotes immediately in a %s', async (kind) => {
  await git(root, 'init', '-b', 'without-remote')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
  await writeFile(join(root, '.git', 'branch-remote'), '[remote "origin"]\n  url = https://gitlab.com/example/project.git\n')
  await git(root, 'config', 'includeIf.onbranch:with-remote.path', 'branch-remote')
  let repoPath = root
  if (kind === 'linked worktree') {
    repoPath = join(root, 'checkout')
    await git(root, 'worktree', 'add', '-b', 'other-branch', repoPath)
  }
  expect(await listCachedRemoteNames(repoPath)).toEqual([])
  expect(await isRemoteListedAbsent(repoPath, 'origin')).toBe(true)
  await git(repoPath, 'checkout', '-b', 'with-remote')
  expect(await git(repoPath, 'remote', 'get-url', 'origin')).toBe('https://gitlab.com/example/project.git')
  expect(await isRemoteListedAbsent(repoPath, 'origin')).toBe(false)
  expect(await listCachedRemoteNames(repoPath)).toEqual(['origin'])
  await git(repoPath, 'checkout', kind === 'folder' ? 'without-remote' : 'other-branch')
  expect(await listCachedRemoteNames(repoPath)).toEqual([])
})
