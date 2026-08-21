/**
 * GitHandler RPC registration surface plus the branch/HEAD lifecycle RPCs:
 * merge/rebase aborts, checkout, branch rename, preserved-branch deletion,
 * commit history, and conflict-operation detection.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  normalizeGitFileText,
  removeGitTempDir
} from './git-handler-test-harness'

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('git.status')
    expect(methods).toContain('git.checkIgnored')
    expect(methods).toContain('git.history')
    expect(methods).toContain('git.commit')
    expect(methods).toContain('git.diff')
    expect(methods).toContain('git.stage')
    expect(methods).toContain('git.unstage')
    expect(methods).toContain('git.bulkStage')
    expect(methods).toContain('git.bulkUnstage')
    expect(methods).toContain('git.abortMerge')
    expect(methods).toContain('git.abortRebase')
    expect(methods).toContain('git.checkout')
    expect(methods).toContain('git.localBranches')
    expect(methods).toContain('git.discard')
    expect(methods).toContain('git.bulkDiscard')
    expect(methods).toContain('git.conflictOperation')
    expect(methods).toContain('git.branchCompare')
    expect(methods).toContain('git.upstreamStatus')
    expect(methods).toContain('git.fetch')
    expect(methods).toContain('git.forkSync')
    expect(methods).toContain('git.fetchRemoteTrackingRef')
    expect(methods).toContain('git.fetchGitHubPullRequestHead')
    expect(methods).toContain('git.fetchGitLabMergeRequestHead')
    expect(methods).toContain('git.fetchGitLabMergeRequestHeadRef')
    expect(methods).toContain('git.push')
    expect(methods).toContain('git.pull')
    expect(methods).toContain('git.fastForward')
    expect(methods).toContain('git.rebaseFromBase')
    expect(methods).toContain('git.branchDiff')
    expect(methods).toContain('git.listWorktrees')
    expect(methods).toContain('git.addWorktree')
    expect(methods).toContain('git.removeWorktree')
    expect(methods).toContain('git.worktreeIsClean')
    expect(methods).toContain('git.refreshLocalBaseRefForWorktreeCreate')
    expect(methods).toContain('git.renameCurrentBranch')
    expect(methods).toContain('git.forceDeletePreservedBranch')
    expect(methods).toContain('git.exec')
    expect(methods).toContain('git.clone')
    expect(methods).toContain('git.isGitRepo')
  })

  it('runs remote worktree deletion inside the relay watcher fence', async () => {
    const removalError = new Error('fenced before Git')
    const runWithRemovalFence = vi.fn(async () => {
      throw removalError
    })
    handler.dispose()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext(), {
      runWithRemovalFence
    })

    await expect(
      dispatcher.callRequest('git.removeWorktree', { worktreePath: '/repo-feature' })
    ).rejects.toBe(removalError)
    expect(runWithRemovalFence).toHaveBeenCalledWith('/repo-feature', expect.any(Function))
  })

  describe('abortMerge', () => {
    it('aborts an in-progress merge', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'feature\n')
      gitCommit(tmpDir, 'feature change')
      execFileSync('git', ['checkout', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'main\n')
      gitCommit(tmpDir, 'main change')

      expect(() =>
        execFileSync('git', ['merge', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      ).toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'MERGE_HEAD'))).resolves.toBeUndefined()

      await dispatcher.callRequest('git.abortMerge', { worktreePath: tmpDir })

      await expect(fs.access(path.join(tmpDir, '.git', 'MERGE_HEAD'))).rejects.toThrow()
      await expect(
        fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8').then(normalizeGitFileText)
      ).resolves.toBe('main\n')
    })
  })

  describe('abortRebase', () => {
    it('aborts an in-progress rebase', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'feature\n')
      gitCommit(tmpDir, 'feature change')
      execFileSync('git', ['checkout', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'main\n')
      gitCommit(tmpDir, 'main change')
      execFileSync('git', ['checkout', 'feature'], { cwd: tmpDir, stdio: 'pipe' })

      expect(() =>
        execFileSync('git', ['rebase', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      ).toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-merge'))).resolves.toBeUndefined()

      await dispatcher.callRequest('git.abortRebase', { worktreePath: tmpDir })

      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-merge'))).rejects.toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-apply'))).rejects.toThrow()
      await expect(
        fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8').then(normalizeGitFileText)
      ).resolves.toBe('feature\n')
    })
  })

  describe('checkout / localBranches', () => {
    it('switches to an existing local branch and lists branches current-first', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['branch', 'feature'], { cwd: tmpDir, stdio: 'pipe' })

      const before = (await dispatcher.callRequest('git.localBranches', {
        worktreePath: tmpDir
      })) as { current: string | null; branches: string[] }
      expect(before.current).toBe(baseBranch)
      expect(before.branches).toContain('feature')
      expect(before.branches[0]).toBe(baseBranch)

      await dispatcher.callRequest('git.checkout', { worktreePath: tmpDir, branch: 'feature' })

      expect(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: tmpDir,
          encoding: 'utf-8',
          stdio: 'pipe'
        }).trim()
      ).toBe('feature')

      const after = (await dispatcher.callRequest('git.localBranches', {
        worktreePath: tmpDir
      })) as { current: string | null; branches: string[] }
      expect(after.current).toBe('feature')
      expect(after.branches[0]).toBe('feature')
    })
  })

  describe('renameCurrentBranch', () => {
    it('renames only the checked-out branch through the narrow RPC', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['checkout', '-b', 'you/Nautilus'], { cwd: tmpDir })

      await dispatcher.callRequest('git.renameCurrentBranch', {
        worktreePath: tmpDir,
        newBranch: 'you/fix-auth'
      })

      const current = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(current).toBe('you/fix-auth')
    })

    it('rejects branch names that look like flags', async () => {
      gitInit(tmpDir)
      await expect(
        dispatcher.callRequest('git.renameCurrentBranch', {
          worktreePath: tmpDir,
          newBranch: '-bad'
        })
      ).rejects.toThrow('Branch name must not start with "-"')
    })
  })

  describe('forceDeletePreservedBranch', () => {
    function headOf(cwd: string, ref: string): string {
      return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf-8' }).trim()
    }

    it('deletes a preserved branch at its expected head through the narrow RPC', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['branch', 'feature/preserved'], { cwd: tmpDir, stdio: 'pipe' })
      const head = headOf(tmpDir, 'refs/heads/feature/preserved')

      await dispatcher.callRequest('git.forceDeletePreservedBranch', {
        repoPath: tmpDir,
        branchName: 'feature/preserved',
        expectedHead: head
      })

      const refs = execFileSync('git', ['branch', '--list', 'feature/preserved'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(refs).toBe('')
    })

    it('refuses to delete when the branch moved past the expected head', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      const staleHead = headOf(tmpDir, 'HEAD')
      execFileSync('git', ['checkout', '-b', 'feature/preserved'], { cwd: tmpDir, stdio: 'pipe' })
      // Advance the branch so the saved (stale) head no longer matches its tip.
      gitCommit(tmpDir, 'second')
      execFileSync('git', ['checkout', '-'], { cwd: tmpDir, stdio: 'pipe' })

      await expect(
        dispatcher.callRequest('git.forceDeletePreservedBranch', {
          repoPath: tmpDir,
          branchName: 'feature/preserved',
          expectedHead: staleHead
        })
      ).rejects.toThrow('changed after the workspace was deleted')
      const refs = execFileSync('git', ['branch', '--list', 'feature/preserved'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(refs).toContain('feature/preserved')
    })

    it('rejects an empty repoPath at the RPC boundary', async () => {
      await expect(
        dispatcher.callRequest('git.forceDeletePreservedBranch', {
          repoPath: '',
          branchName: 'feature/preserved',
          expectedHead: 'abc123'
        })
      ).rejects.toThrow('Invalid preserved branch force-delete request.')
    })
  })

  describe('history', () => {
    it('returns bounded git history for a repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      gitCommit(tmpDir, 'second')

      const result = (await dispatcher.callRequest('git.history', {
        worktreePath: tmpDir,
        limit: 10
      })) as {
        items: { subject: string; displayId?: string }[]
        currentRef?: { category?: string; revision?: string }
        hasMore: boolean
        limit: number
      }

      expect(result.items.map((item) => item.subject)).toEqual(['second', 'initial'])
      expect(result.currentRef?.category).toBe('branches')
      expect(result.currentRef?.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(result.items[0]?.displayId).toHaveLength(7)
      expect(result.hasMore).toBe(false)
      expect(result.limit).toBe(10)
    })
  })

  describe('conflictOperation', () => {
    it('returns unknown for normal repo', async () => {
      gitInit(tmpDir)
      gitCommit(tmpDir, 'initial')

      const result = await dispatcher.callRequest('git.conflictOperation', { worktreePath: tmpDir })
      expect(result).toBe('unknown')
    })
  })
})
