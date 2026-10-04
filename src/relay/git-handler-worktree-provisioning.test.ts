/**
 * GitHandler worktree provisioning: the local base-ref refresh that precedes a
 * worktree create, and the addWorktree state machine (base ref qualification,
 * push.autoSetupRemote probing, failure handling).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir,
  type GitSpyTarget
} from './git-handler-test-harness'

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher } = createGitHandlerRelay())
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  function currentBranch(cwd: string): string {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8'
    }).trim()
  }

  function currentBranchFullRef(cwd: string): string {
    return `refs/heads/${currentBranch(cwd)}`
  }

  function reportedWorktreePath(cwd: string): string {
    return (
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd,
        encoding: 'utf-8'
      })
        .split(/\r?\n/)
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length)
        .trim() ?? cwd
    )
  }

  describe('refreshLocalBaseRefForWorktreeCreate', () => {
    function setupMockedRefreshHandler() {
      const localDispatcher = createMockDispatcher()
      const localHandler = new GitHandler(
        localDispatcher as unknown as RelayDispatcher,
        new RelayContext()
      )
      const gitMock =
        vi.fn<
          (
            args: string[],
            cwd: string,
            opts?: { maxBuffer?: number }
          ) => Promise<{ stdout: string; stderr: string }>
        >()
      ;(localHandler as unknown as { git: typeof gitMock }).git = gitMock
      return { localDispatcher, gitMock }
    }

    function revParse(ref: string): string {
      return execFileSync('git', ['rev-parse', ref], { cwd: tmpDir, encoding: 'utf-8' }).trim()
    }

    // The checked-out branch is one commit behind refs/remotes/origin/main, which changes base.txt.
    function initBehindRepo(): { branchRef: string; localSha: string; remoteSha: string } {
      gitInit(tmpDir)
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const localSha = revParse('HEAD')
      writeFileSync(path.join(tmpDir, 'base.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = revParse('HEAD')
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      execFileSync('git', ['reset', '--hard', localSha], { cwd: tmpDir, stdio: 'pipe' })
      return { branchRef: currentBranchFullRef(tmpDir), localSha, remoteSha }
    }

    it('fast-forwards the owning worktree to the remote-tracking ref on the host', async () => {
      const { branchRef, remoteSha } = initBehindRepo()

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: branchRef,
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'updated', ownerWorktreePath: reportedWorktreePath(tmpDir) })

      expect(revParse('HEAD')).toBe(remoteSha)
      await expect(fs.readFile(path.join(tmpDir, 'base.txt'), 'utf-8')).resolves.toBe('remote')
    })

    it('fast-forwards a non-checked-out local branch via update-ref', async () => {
      const { localSha, remoteSha } = initBehindRepo()
      execFileSync('git', ['branch', 'main-copy', localSha], { cwd: tmpDir, stdio: 'pipe' })

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/heads/main-copy',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'updated' })

      expect(revParse('refs/heads/main-copy')).toBe(remoteSha)
    })

    it('reports nothing to do for a local branch that does not exist yet', async () => {
      initBehindRepo()

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/heads/not-created-yet',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'nothing_to_do' })
    })

    it.each([
      [
        'refs outside heads/remotes',
        { fullRef: 'refs/tags/main', remoteTrackingRef: 'refs/remotes/origin/main' },
        'Invalid local base ref refresh refs.'
      ],
      [
        'a non-string ref',
        { fullRef: 42, remoteTrackingRef: 'refs/remotes/origin/main' },
        'Invalid local base ref refresh request.'
      ],
      [
        'a missing remote-tracking ref',
        { fullRef: 'refs/heads/main' },
        'Invalid local base ref refresh request.'
      ]
    ])('rejects %s without touching git', async (_case, params, message) => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()

      for (const method of [
        'git.refreshLocalBaseRefForWorktreeCreate',
        'git.inspectLocalBaseRefForWorktreeCreate'
      ]) {
        await expect(
          localDispatcher.callRequest(method, { repoPath: '/repo', ...params })
        ).rejects.toThrow(message)
      }
      expect(gitMock).not.toHaveBeenCalled()
    })

    it('rejects a ref name git itself refuses', async () => {
      gitInit(tmpDir)

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/heads/bad..name',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).rejects.toThrow()
    })

    it('leaves a dirty owner worktree and its edit alone', async () => {
      const { branchRef, localSha } = initBehindRepo()
      writeFileSync(path.join(tmpDir, 'base.txt'), 'local dirty')

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: branchRef,
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({
        status: 'skipped_dirty_worktree',
        ownerWorktreePath: reportedWorktreePath(tmpDir)
      })

      expect(revParse('HEAD')).toBe(localSha)
      await expect(fs.readFile(path.join(tmpDir, 'base.txt'), 'utf-8')).resolves.toBe('local dirty')
    })

    it('does not move diverged local refs', async () => {
      const { localSha } = initBehindRepo()
      execFileSync('git', ['checkout', '-q', '-b', 'main-copy', localSha], { cwd: tmpDir })
      writeFileSync(path.join(tmpDir, 'local.txt'), 'local')
      gitCommit(tmpDir, 'local update')
      const divergedSha = revParse('refs/heads/main-copy')

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/heads/main-copy',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'skipped_not_fast_forward' })

      expect(revParse('refs/heads/main-copy')).toBe(divergedSha)
    })

    it('inspects how far local is behind without moving it', async () => {
      const { branchRef, localSha, remoteSha } = initBehindRepo()

      await expect(
        dispatcher.callRequest('git.inspectLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: branchRef,
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({
        status: 'behind',
        behind: 1,
        localOid: localSha,
        remoteOid: remoteSha,
        ownerWorktreePath: reportedWorktreePath(tmpDir)
      })

      expect(revParse('HEAD')).toBe(localSha)
      await expect(fs.readFile(path.join(tmpDir, 'base.txt'), 'utf-8')).resolves.toBe('base')
    })

    function mockBehindOwnerGit(
      gitMock: ReturnType<typeof setupMockedRefreshHandler>['gitMock'],
      onMerge: () => Promise<void> = async () => {}
    ) {
      let localOid = 'old-local-oid'
      gitMock.mockImplementation(async (args: string[]) => {
        const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c')
        if (command === 'check-ref-format' || command === 'status') {
          return { stdout: '', stderr: '' }
        }
        if (command === 'rev-parse') {
          const oid = args[2] === 'refs/remotes/origin/main^{commit}' ? 'remote-oid' : localOid
          return { stdout: `${oid}\n`, stderr: '' }
        }
        if (command === 'rev-list') {
          return { stdout: '0\t2\n', stderr: '' }
        }
        if (command === 'worktree') {
          return {
            stdout: 'worktree /repo\0HEAD old-local-oid\0branch refs/heads/main\0\0',
            stderr: ''
          }
        }
        if (command === 'symbolic-ref') {
          return { stdout: 'refs/heads/main\n', stderr: '' }
        }
        if (command === 'merge') {
          await onMerge()
          localOid = 'remote-oid'
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      })
    }

    it('fast-forwards the owner with merge --ff-only and hooks disabled, never reset or update-ref', async () => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()
      mockBehindOwnerGit(gitMock)

      await expect(
        localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: '/repo',
          fullRef: 'refs/heads/main',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'updated', ownerWorktreePath: '/repo' })

      const merge = gitMock.mock.calls.find(([args]) => args.includes('merge'))
      expect(merge?.[0]).toEqual(
        expect.arrayContaining([
          'core.hooksPath=/dev/null',
          'branch.main.mergeOptions=',
          '--ff-only',
          'recursive',
          '--no-verify-signatures',
          'remote-oid'
        ])
      )
      expect(merge?.[1]).toBe('/repo')
      const commands = gitMock.mock.calls.map(([args]) => args[0])
      expect(commands).not.toContain('reset')
      expect(commands).not.toContain('update-ref')
    })

    it('runs one refresh per branch at a time for every client of the relay', async () => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()
      let releaseMerge!: () => void
      const mergeHeld = new Promise<void>((resolve) => (releaseMerge = resolve))
      mockBehindOwnerGit(gitMock, () => mergeHeld)
      const params = {
        repoPath: '/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main'
      }

      const first = localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', params)
      await vi.waitFor(() =>
        expect(gitMock.mock.calls.some(([args]) => args.includes('merge'))).toBe(true)
      )
      const second = localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', params)
      // Let the second request get past validation and as far as it can while the merge is held.
      await vi.waitFor(() =>
        expect(gitMock.mock.calls.filter(([args]) => args[0] === 'check-ref-format').length).toBe(4)
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseMerge()

      await expect(first).resolves.toEqual({ status: 'updated', ownerWorktreePath: '/repo' })
      // The joiner's follow-up run finds local already at the target.
      await expect(second).resolves.toEqual({ status: 'nothing_to_do' })
      expect(gitMock.mock.calls.filter(([args]) => args.includes('merge'))).toHaveLength(1)
    })

    // A fork on the real host: the checked-out branch behind origin/main, one commit behind upstream/main.
    function initForkRepo(): { branchRef: string; upstreamSha: string } {
      const { branchRef, localSha, remoteSha } = initBehindRepo()
      execFileSync('git', ['checkout', '-q', '-b', 'fork-upstream', remoteSha], { cwd: tmpDir })
      writeFileSync(path.join(tmpDir, 'base.txt'), 'upstream')
      gitCommit(tmpDir, 'upstream update')
      const upstreamSha = revParse('HEAD')
      execFileSync('git', ['checkout', '-q', '-'], { cwd: tmpDir })
      execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', upstreamSha], {
        cwd: tmpDir
      })
      execFileSync('git', ['branch', '-q', '-D', 'fork-upstream'], { cwd: tmpDir })
      expect(revParse('HEAD')).toBe(localSha)
      return { branchRef, upstreamSha }
    }

    /** Sends refreshes in order, each reaching the relay's per-branch queue while the first merge is held. */
    async function refreshWhileFirstMergeHeld(branchRef: string, remotes: string[]) {
      const { dispatcher: relay, handler } = createGitHandlerRelay()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: GitHandler really has this private git runner; the spy wraps the real one.
      const target = handler as unknown as GitSpyTarget
      const realGit = target.git.bind(handler)
      let releaseMerge!: () => void
      const mergeHeld = new Promise<void>((resolve) => (releaseMerge = resolve))
      let merges = 0
      let activeMerges = 0
      let maxConcurrentMerges = 0
      let refFormatChecks = 0
      vi.spyOn(target, 'git').mockImplementation(async (args, cwd, opts) => {
        if (args.includes('check-ref-format')) {
          const result = await realGit(args, cwd, opts)
          refFormatChecks += 1
          return result
        }
        if (!args.includes('merge')) {
          return realGit(args, cwd, opts)
        }
        merges += 1
        activeMerges += 1
        maxConcurrentMerges = Math.max(maxConcurrentMerges, activeMerges)
        try {
          if (merges === 1) {
            await mergeHeld
          }
          return await realGit(args, cwd, opts)
        } finally {
          activeMerges -= 1
        }
      })

      const results: Promise<unknown>[] = []
      for (const [index, remote] of remotes.entries()) {
        results.push(
          relay.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
            repoPath: tmpDir,
            fullRef: branchRef,
            remoteTrackingRef: `refs/remotes/${remote}/main`
          })
        )
        if (index === 0) {
          await vi.waitFor(() => expect(merges).toBe(1))
        } else {
          await vi.waitFor(() => expect(refFormatChecks).toBe(2 * (index + 1)))
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      releaseMerge()
      return { results: await Promise.all(results), maxConcurrentMerges: () => maxConcurrentMerges }
    }

    it('moves the branch to a target a later client asked for from another remote', async () => {
      const { branchRef, upstreamSha } = initForkRepo()

      const { results, maxConcurrentMerges } = await refreshWhileFirstMergeHeld(branchRef, [
        'origin',
        'upstream',
        'origin'
      ])

      const owner = reportedWorktreePath(tmpDir)
      // The third is the existing ahead-of-requested-remote rule (local is past origin/main), not a sharing artifact.
      expect(results).toEqual([
        { status: 'updated', ownerWorktreePath: owner },
        { status: 'updated', ownerWorktreePath: owner },
        { status: 'skipped_not_fast_forward' }
      ])
      expect(revParse('HEAD')).toBe(upstreamSha)
      expect(maxConcurrentMerges()).toBe(1)
    })

    it('never answers a client with the outcome of another remote target', async () => {
      const { branchRef, upstreamSha } = initForkRepo()

      const { results, maxConcurrentMerges } = await refreshWhileFirstMergeHeld(branchRef, [
        'upstream',
        'upstream',
        'origin'
      ])

      // The third is the existing ahead-of-requested-remote rule (local is past origin/main), not a sharing artifact.
      expect(results).toEqual([
        { status: 'updated', ownerWorktreePath: reportedWorktreePath(tmpDir) },
        { status: 'nothing_to_do' },
        { status: 'skipped_not_fast_forward' }
      ])
      expect(revParse('HEAD')).toBe(upstreamSha)
      expect(maxConcurrentMerges()).toBe(1)
    })

    it('reports an error without mutating when worktree ownership cannot be listed', async () => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()
      mockBehindOwnerGit(gitMock)
      const base = gitMock.getMockImplementation()!
      gitMock.mockImplementation(async (args, cwd) => {
        if (args[0] === 'worktree') {
          throw new Error('worktree list failed')
        }
        return base(args, cwd)
      })

      await expect(
        localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: '/repo',
          fullRef: 'refs/heads/main',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toEqual({ status: 'skipped_error' })

      const commands = gitMock.mock.calls.map(([args]) => args)
      expect(commands.some((args) => args.includes('merge') || args[0] === 'update-ref')).toBe(
        false
      )
    })
  })

  describe('addWorktree', () => {
    // Why: mock git to control exit codes (e.g. --get exit 1 vs other) deterministically, independent of host git config.
    function setupMockedHandler(roots: string[]) {
      const ctx = new RelayContext()
      for (const r of roots) {
        ctx.registerRoot(r)
      }
      const localDispatcher = createMockDispatcher()
      const handler = new GitHandler(localDispatcher as unknown as RelayDispatcher, ctx)
      const gitMock =
        vi.fn<
          (
            args: string[],
            cwd: string,
            opts?: { maxBuffer?: number }
          ) => Promise<{ stdout: string; stderr: string }>
        >()
      ;(handler as unknown as { git: typeof gitMock }).git = gitMock
      return { localDispatcher, gitMock }
    }

    it('passes --no-track and writes push.autoSetupRemote when unset', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }) // rev-parse refs/remotes/origin/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --local set

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/test',
        targetDir: '/relay/wt',
        base: 'origin/main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/relay/wt',
          'refs/remotes/origin/main'
        ],
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        ['config', '--get', 'push.autoSetupRemote'],
        ['config', '--local', 'push.autoSetupRemote', 'true']
      ])
      // cwd for worktree add is repoPath; cwd for config calls is targetDir.
      expect(gitMock.mock.calls[0]?.[1]).toBe('/relay/repo')
      expect(gitMock.mock.calls[1]?.[1]).toBe('/relay/repo')
      expect(gitMock.mock.calls[2]?.[1]).toBe('/relay/wt')
      expect(gitMock.mock.calls[3]?.[1]).toBe('/relay/wt')
      expect(gitMock.mock.calls[4]?.[1]).toBe('/relay/wt')
    })

    it('checks out a selected existing local branch without creating a new branch', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/test',
        targetDir: '/relay/wt',
        base: 'feature/test',
        checkoutExistingBranch: true
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['worktree', 'add', '/relay/wt', 'feature/test']
      ])
    })

    it('qualifies bare branch name as refs/heads/ when a same-named tag exists', async () => {
      // Why: a local tag named 'main' makes bare-name `worktree add ... main` ambiguous; refs/heads/ disambiguates.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }) // rev-parse refs/heads/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get unset
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --local set

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/disambig',
        targetDir: '/relay/wt',
        base: 'main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        ['worktree', 'add', '--no-track', '-b', 'feature/disambig', '/relay/wt', 'refs/heads/main'],
        ['config', '--local', '--replace-all', 'branch.feature/disambig.base', 'refs/heads/main'],
        ['config', '--get', 'push.autoSetupRemote'],
        ['config', '--local', 'push.autoSetupRemote', 'true']
      ])
    })

    it('passes --no-checkout when sparse setup will checkout after configuration', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // rev-parse refs/remotes/origin/main
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --local set

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/sparse',
        targetDir: '/relay/wt',
        base: 'origin/main',
        noCheckout: true
      })

      expect(gitMock.mock.calls[1]?.[0]).toEqual([
        'worktree',
        'add',
        '--no-track',
        '--no-checkout',
        '-b',
        'feature/sparse',
        '/relay/wt',
        'refs/remotes/origin/main'
      ])
    })

    it('preserves an existing push.autoSetupRemote value (does not overwrite user-set false)', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('not a branch')) // rev-parse refs/heads/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // --get returns value

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/preserve',
        targetDir: '/relay/wt',
        base: 'main'
      })

      // No --local set: --get succeeded so we preserve the user's value.
      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        ['worktree', 'add', '--no-track', '-b', 'feature/preserve', '/relay/wt', 'main'],
        ['config', '--local', '--replace-all', 'branch.feature/preserve.base', 'main'],
        ['config', '--get', 'push.autoSetupRemote']
      ])
    })

    it('treats --get success with empty stdout as "already set" (key present but blank)', async () => {
      // Why: --get exits 0 for any value including empty string, so an empty value must not fall through to set-true.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('not a branch')) // rev-parse refs/heads/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --get success, empty value

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/empty',
        targetDir: '/relay/wt',
        base: 'main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        ['worktree', 'add', '--no-track', '-b', 'feature/empty', '/relay/wt', 'main'],
        ['config', '--local', '--replace-all', 'branch.feature/empty.base', 'main'],
        ['config', '--get', 'push.autoSetupRemote']
      ])
    })

    it('does not write --local when --get fails with non-unset code (corrupt config)', async () => {
      // Why: only --get exit 1 means "unset"; any other code is a real read failure, so don't fall through to set-true.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('not a branch')) // rev-parse refs/heads/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('parse error'), { code: 3 })) // --get non-unset

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(
        localDispatcher.callRequest('git.addWorktree', {
          repoPath: '/relay/repo',
          branchName: 'feature/corrupt',
          targetDir: '/relay/wt',
          base: 'main'
        })
      ).resolves.toBeUndefined()

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        ['worktree', 'add', '--no-track', '-b', 'feature/corrupt', '/relay/wt', 'main'],
        ['config', '--local', '--replace-all', 'branch.feature/corrupt.base', 'main'],
        ['config', '--get', 'push.autoSetupRemote']
      ])
      expect(warnSpy).toHaveBeenCalledWith(
        'relay addWorktree: failed to set push.autoSetupRemote for /relay/wt',
        expect.any(Error)
      )
      warnSpy.mockRestore()
    })

    it('warns but resolves when --local set fails (write-failure is warn-only)', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('not a branch')) // rev-parse refs/heads/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get unset
      gitMock.mockRejectedValueOnce(new Error('config locked')) // --local set fails

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(
        localDispatcher.callRequest('git.addWorktree', {
          repoPath: '/relay/repo',
          branchName: 'feature/writefail',
          targetDir: '/relay/wt',
          base: 'main'
        })
      ).resolves.toBeUndefined()

      expect(warnSpy).toHaveBeenCalledWith(
        'relay addWorktree: failed to set push.autoSetupRemote for /relay/wt',
        expect.any(Error)
      )
      warnSpy.mockRestore()
    })

    it('does not write config when worktree add itself fails', async () => {
      // Why: config probes must run only after worktree add succeeds (never against an uncreated dir).
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('not a branch')) // rev-parse refs/heads/main^{commit}
      gitMock.mockRejectedValueOnce(new Error('worktree add failed'))

      await expect(
        localDispatcher.callRequest('git.addWorktree', {
          repoPath: '/relay/repo',
          branchName: 'feature/fail',
          targetDir: '/relay/wt',
          base: 'main'
        })
      ).rejects.toThrow('worktree add failed')

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
        ['worktree', 'add', '--no-track', '-b', 'feature/fail', '/relay/wt', 'main']
      ])
    })
  })
})
