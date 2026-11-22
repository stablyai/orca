import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../command-runner/git-exec-file', () => ({
  gitExecFileAsync: async (args: string[], options: { cwd: string }) =>
    promisify(execFile)('git', args, { cwd: options.cwd })
}))

import {
  _resetRemoteNameListingCache,
  isRemoteListedAbsent,
  listCachedRemoteNames
} from './remote-name-listing'

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

it.each(['folder', 'linked worktree', 'escaped condition'])(
  'refreshes branch-conditional remotes immediately in a %s',
  async (kind) => {
    await git(root, 'init', '-b', 'nope-remote')
    await git(
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    )
    await writeFile(
      join(root, '.git', 'branch-remote'),
      '[remote "origin"]\n  url = https://gitlab.com/example/project.git\n'
    )
    await (kind === 'folder'
      ? git(root, 'config', 'includeIf.onbranch:with-remote.path', 'branch-remote')
      : appendFile(
          join(root, '.git', 'config'),
          kind === 'escaped condition'
            ? '[includeIf "onbranch\\:with-remote"] path = branch-remote\n'
            : '[includeIf "onbranch:with-remote"] path = branch-remote\n'
        ))
    let repoPath = root
    if (kind === 'linked worktree') {
      repoPath = join(root, 'checkout')
      await git(root, 'worktree', 'add', '-b', 'else-remote', repoPath)
    }
    expect(await listCachedRemoteNames(repoPath)).toEqual([])
    expect(await isRemoteListedAbsent(repoPath, 'origin')).toBe(true)
    const headPath = await git(repoPath, 'rev-parse', '--git-path', 'HEAD')
    const absoluteHead = isAbsolute(headPath) ? headPath : join(repoPath, headPath)
    const beforeHead = await stat(absoluteHead)
    await git(repoPath, 'checkout', '-b', 'with-remote')
    await utimes(absoluteHead, beforeHead.atime, beforeHead.mtime)
    expect(await git(repoPath, 'remote', 'get-url', 'origin')).toBe(
      'https://gitlab.com/example/project.git'
    )
    expect(await isRemoteListedAbsent(repoPath, 'origin')).toBe(false)
    expect(await listCachedRemoteNames(repoPath)).toEqual(['origin'])
    await git(repoPath, 'checkout', kind === 'linked worktree' ? 'else-remote' : 'nope-remote')
    expect(await listCachedRemoteNames(repoPath)).toEqual([])
  }
)
