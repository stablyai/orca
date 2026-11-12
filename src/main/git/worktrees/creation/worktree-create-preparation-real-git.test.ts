import { execFileSync } from 'node:child_process'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as gitRunner from '../../command-runner/git-exec-file'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/create-preparation'

import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(): Promise<{ repoPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-prepared-worktree-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return { repoPath, root }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['replacement', 'permission'])(
  'preserves the requested path when rollback loses %s authority',
  async (kind) => {
    const { repoPath, root } = await createRepo()
    const prepared = join(root, 'prepared-rollback-authority')
    const target = join(root, 'rollback-target')
    const preserved = join(root, 'preserved-original')
    const reason = createWorktreePreparationLockReason('rollback-authority')
    await prepareWorktreeCreateCheckout(repoPath, prepared, 'main', reason)
    const originalLock = git(prepared, ['rev-parse', '--git-path', 'locked'])
    const failure = new Error('move rewrote pointers but rejected')
    const run = gitRunner.gitExecFileAsync
    let allowed = true
    let replaced = false
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args.includes('move')) {
        await run(args, options)
        if (kind === 'permission') {
          allowed = false
        }
        throw failure
      }
      if (
        kind === 'replacement' &&
        args[0] === 'symbolic-ref' &&
        options.cwd === target &&
        !replaced
      ) {
        replaced = true
        git(repoPath, ['worktree', 'move', '-f', '-f', target, preserved])
        git(repoPath, ['worktree', 'add', '--detach', target, 'HEAD'])
        git(repoPath, ['worktree', 'lock', '--reason', reason, target])
        await writeFile(join(target, 'user.txt'), 'preserve replacement\n')
      }
      return run(args, options)
    })
    try {
      await expect(
        finalizePreparedWorktree(
          repoPath,
          prepared,
          target,
          'rollback-authority',
          'main',
          false,
          { canStart: () => allowed },
          reason
        )
      ).rejects.toBe(failure)
      expect(await readFile(join(target, 'version.txt'), 'utf8')).toBe('one\n')
      if (kind === 'replacement') {
        expect(replaced).toBe(true)
        expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('preserve replacement\n')
        expect(await readFile(join(preserved, 'version.txt'), 'utf8')).toBe('one\n')
      }
      expect(await readFile(originalLock, 'utf8')).toBe(`${reason}\n`)
    } finally {
      vi.restoreAllMocks()
    }
  }
)
