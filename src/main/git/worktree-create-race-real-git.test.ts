import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitExec } from '../../relay/git-handler-ops'
import { addWorktreeOp } from '../../relay/git-handler-worktree-ops'
import { addWorktree } from './worktree'

const execFileAsync = promisify(execFile)

let root = ''
let repo = ''

async function git(args: string[], cwd = repo): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd })
}

async function initializeRepository(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-create-race-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await git(['init', '-q'])
  await git(['config', 'user.email', 'race@example.invalid'])
  await git(['config', 'user.name', 'Worktree Race'])
  await writeFile(join(repo, 'seed.txt'), 'seed\n')
  await git(['add', 'seed.txt'])
  await git(['commit', '-qm', 'seed'])
  await mkdir(join(repo, '.git', 'git-crypt'))
}

async function expectWinnerPreserved(target: string, branch: string): Promise<void> {
  const { stdout: worktrees } = await git(['worktree', 'list', '--porcelain'])
  const { stdout: head } = await git(['rev-parse', '--verify', `refs/heads/${branch}`])
  expect(worktrees).toContain(`worktree ${target}`)
  expect(worktrees).toContain(`branch refs/heads/${branch}`)
  expect(head.trim()).toMatch(/^[0-9a-f]{40,64}$/)
}

beforeEach(initializeRepository)
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('same-target worktree create race against real Git', () => {
  it('keeps the local winner registered after the serialized loser fails', async () => {
    const target = join(root, 'winner-local')
    const branch = 'race/local'
    const winner = addWorktree(repo, target, branch)
    const loser = addWorktree(repo, target, branch)

    await expect(winner).resolves.toEqual({})
    await expect(loser).rejects.toThrow()
    await expectWinnerPreserved(target, branch)
  })

  it('keeps the relay winner registered after the serialized loser fails', async () => {
    const target = join(root, 'winner-relay')
    const branch = 'race/relay'
    const relayGit: GitExec = async (args, cwd, options) =>
      execFileAsync('git', args, {
        cwd,
        signal: options?.signal,
        timeout: options?.timeout
      })
    const params = { repoPath: repo, targetDir: target, branchName: branch }
    const winner = addWorktreeOp(relayGit, params)
    const loser = addWorktreeOp(relayGit, params)

    await expect(winner).resolves.toBeUndefined()
    await expect(loser).rejects.toThrow()
    await expectWinnerPreserved(target, branch)
  })
})
