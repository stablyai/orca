import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { removeWorktreeOp } from '../../relay/git-handler-worktree-remove'
import type { GitExec } from '../../relay/git-handler-ops'
import { deleteBranchAfterWorktreeRemoval, forceDeleteLocalBranch } from './worktree-branch-removal'
import { forceDeletePreservedRelayBranch } from '../../relay/git-handler-branch-cleanup'
import { BranchDeletionUnverifiedError } from '../../shared/git-branch-delete-verification'
import { removeWorktree } from './worktree-removal'
import { whenWorktreeTrashDeletionsSettled } from '../worktree-trash'

let root: string
let repo: string
let worktree: string
let branchHead: string

const executeGit: GitExec = async (args, cwd, options) => {
  const result = await runProcess({ program: 'git', args, cwd, input: options?.stdin })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), result)
  }
  return result
}

async function git(args: string[], cwd = repo): Promise<string> {
  return (await executeGit(args, cwd)).stdout.trim()
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-branch-retention-')))
  repo = join(root, 'repo')
  worktree = join(root, 'feature')
  await mkdir(repo)
  await git(['init', '-q'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(['config', 'user.name', 'Branch Retention'])
  await git(['config', 'user.email', 'retention@example.invalid'])
  await writeFile(join(repo, 'base.txt'), 'base\n')
  await git(['add', '.'])
  await git(['commit', '-qm', 'base'])
  await git(['init', '--bare', '-q', join(root, 'remote.git')])
  await git(['remote', 'add', 'origin', join(root, 'remote.git')])
  await git(['push', '-u', 'origin', 'main'])
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  await git(['worktree', 'add', '-q', '-b', 'feature/test', worktree])
  await git(['config', 'branch.feature/test.base', 'refs/remotes/origin/main'])
  await writeFile(join(worktree, 'change.txt'), 'unmerged work\n')
  await git(['add', '.'], worktree)
  await git(['commit', '-qm', 'feature'], worktree)
  await git(['push', '-u', 'origin', 'feature/test'], worktree)
  branchHead = await git(['rev-parse', 'feature/test'])
})

afterEach(async () => {
  await whenWorktreeTrashDeletionsSettled()
  await rm(root, { recursive: true, force: true })
})

describe.each(['local', 'relay'] as const)(
  '%s worktree branch retention against real Git',
  (executor) => {
    function remove(force = false, forceBranchDelete = false) {
      return executor === 'local'
        ? removeWorktree(repo, worktree, force, { forceBranchDelete })
        : removeWorktreeOp(
            executeGit,
            { worktreePath: worktree, force, forceBranchDelete },
            new GitCapabilityCache()
          )
    }

    it.each([false, true])(
      'preserves pushed unmerged commits when removing a worktree (force=%s)',
      async (force) => {
        expect(await git(['rev-list', '--count', 'origin/main..feature/test'])).toBe('1')
        expect(await git(['rev-list', '--count', 'origin/feature/test..feature/test'])).toBe('0')

        expect(await remove(force)).toEqual({
          preservedBranch: { branchName: 'feature/test', head: branchHead }
        })
        expect(await git(['rev-parse', 'feature/test'])).toBe(branchHead)
        expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
          'refs/heads/feature/test'
        )
        await expect(access(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    )

    it.each(['merge', 'squash'] as const)(
      'cleans up a branch after a %s into the base',
      async (kind) => {
        await git(
          kind === 'merge'
            ? ['merge', '--ff-only', 'feature/test']
            : ['merge', '--squash', 'feature/test']
        )
        if (kind === 'squash') {
          await git(['commit', '-qm', 'squash feature'])
        }
        await git(['push', 'origin', 'main'])
        expect(await remove()).toEqual({})
        expect(await git(['branch', '--list', 'feature/test'])).toBe('')
      }
    )

    it('keeps explicit failed-creation rollback force deletion', async () => {
      expect(await remove(false, true)).toEqual({})
      expect(await git(['branch', '--list', 'feature/test'])).toBe('')
    })

    it('keeps the branch when only an unrelated primary checkout contains its commits', async () => {
      await git(['checkout', '-qb', 'feature/other', 'feature/test'])
      expect(await remove()).toEqual({
        preservedBranch: { branchName: 'feature/test', head: branchHead }
      })
      expect(await git(['rev-parse', 'feature/test'])).toBe(branchHead)
      expect(await git(['rev-list', '--count', 'origin/main..feature/test'])).toBe('1')
    })

    it.each([false, true])(
      'does not claim a branch was kept after a failed post-delete scan (restore fails=%s)',
      async (failRestore) => {
        await git(['worktree', 'remove', worktree])
        let deleted = false
        const interruptedGit: GitExec = async (args, cwd, options) => {
          if (deleted && args[0] === 'worktree') {
            throw new Error('checkout scan failed')
          }
          if (deleted && args[0] === 'update-ref' && failRestore) {
            throw new Error('restore failed')
          }
          const result = await executeGit(args, cwd, options)
          if (args[0] === 'update-ref' && args[1] === '-d') {
            deleted = true
          }
          return result
        }
        const deletion =
          executor === 'local'
            ? forceDeleteLocalBranch(repo, 'feature/test', branchHead, interruptedGit)
            : forceDeletePreservedRelayBranch(interruptedGit, repo, 'feature/test', branchHead)
        if (failRestore) {
          await expect(deletion).rejects.toBeInstanceOf(BranchDeletionUnverifiedError)
        } else {
          await expect(deletion).rejects.toThrow('checkout scan failed')
          expect(await git(['rev-parse', 'feature/test'])).toBe(branchHead)
        }
      }
    )
  }
)

it('keeps a branch whose head changed after removal captured it', async () => {
  await git(['worktree', 'remove', worktree])
  await git(['merge', '--ff-only', 'feature/test'])
  await git(['push', 'origin', 'main'])
  const tree = await git(['rev-parse', 'HEAD^{tree}'])
  const newer = await git(['commit-tree', tree, '-p', branchHead, '-m', 'newer work'])
  await git(['update-ref', 'refs/heads/feature/test', newer])
  expect(await deleteBranchAfterWorktreeRemoval(repo, 'feature/test', branchHead, {})).toEqual({
    preservedBranch: { branchName: 'feature/test', head: branchHead }
  })
  expect(await git(['rev-parse', 'feature/test'])).toBe(newer)
})
