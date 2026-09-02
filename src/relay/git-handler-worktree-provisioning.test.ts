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
  removeGitTempDir
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

    it('resets the owning worktree to the remote-tracking ref', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const branchRef = currentBranchFullRef(tmpDir)
      const ownerPath = reportedWorktreePath(tmpDir)
      const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      writeFileSync(path.join(tmpDir, 'base.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      execFileSync('git', ['reset', '--hard', firstSha], { cwd: tmpDir, stdio: 'pipe' })

      await dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
        repoPath: tmpDir,
        fullRef: branchRef,
        remoteTrackingRef: 'refs/remotes/origin/main',
        ownerWorktreePath: ownerPath
      })

      const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(actual).toBe(remoteSha)
      await expect(fs.readFile(path.join(tmpDir, 'base.txt'), 'utf-8')).resolves.toBe('remote')
    })

    it('fast-forwards a non-checked-out local branch via update-ref', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['branch', 'main-copy'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'base.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })

      await dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
        repoPath: tmpDir,
        fullRef: 'refs/heads/main-copy',
        remoteTrackingRef: 'refs/remotes/origin/main'
      })

      // No working tree owns main-copy, so the bare ref fast-forwards.
      const actual = execFileSync('git', ['rev-parse', 'refs/heads/main-copy'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(actual).toBe(remoteSha)
    })

    it('does not move a non-checked-out local branch when checkOnly is set', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['branch', 'main-copy'], { cwd: tmpDir, stdio: 'pipe' })
      const originalSha = execFileSync('git', ['rev-parse', 'refs/heads/main-copy'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      writeFileSync(path.join(tmpDir, 'base.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })

      await dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
        repoPath: tmpDir,
        fullRef: 'refs/heads/main-copy',
        remoteTrackingRef: 'refs/remotes/origin/main',
        checkOnly: true
      })

      const actual = execFileSync('git', ['rev-parse', 'refs/heads/main-copy'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(actual).toBe(originalSha)
    })

    it('rejects invalid local base ref refresh refs', async () => {
      gitInit(tmpDir)

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/tags/main',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).rejects.toThrow('Invalid local base ref refresh refs.')
    })

    it('rejects a dirty owner worktree before resetting', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const branchRef = currentBranchFullRef(tmpDir)
      const ownerPath = reportedWorktreePath(tmpDir)
      const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      writeFileSync(path.join(tmpDir, 'base.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      execFileSync('git', ['reset', '--hard', firstSha], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'base.txt'), 'local dirty')

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: branchRef,
          remoteTrackingRef: 'refs/remotes/origin/main',
          ownerWorktreePath: ownerPath
        })
      ).rejects.toThrow('Local base ref worktree has tracked changes.')

      const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(actual).toBe(firstSha)
      await expect(fs.readFile(path.join(tmpDir, 'base.txt'), 'utf-8')).resolves.toBe('local dirty')
    })

    it('rejects when the caller-supplied owner path is not the checked-out branch owner', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const branchRef = currentBranchFullRef(tmpDir)
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', headSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: branchRef,
          remoteTrackingRef: 'refs/remotes/origin/main',
          ownerWorktreePath: path.join(path.dirname(tmpDir), 'different-owner')
        })
      ).rejects.toThrow('Local base ref is checked out in a different worktree.')
    })

    it('rejects diverged local refs before mutating', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['branch', 'main-copy'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'remote.txt'), 'remote')
      gitCommit(tmpDir, 'remote update')
      const remoteSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteSha], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      execFileSync('git', ['checkout', 'main-copy'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'local.txt'), 'local')
      gitCommit(tmpDir, 'local update')
      const localSha = execFileSync('git', ['rev-parse', 'refs/heads/main-copy'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      await expect(
        dispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: tmpDir,
          fullRef: 'refs/heads/main-copy',
          remoteTrackingRef: 'refs/remotes/origin/main',
          ownerWorktreePath: tmpDir
        })
      ).rejects.toThrow('Local base ref is not a fast-forward update.')

      const actual = execFileSync('git', ['rev-parse', 'refs/heads/main-copy'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(actual).toBe(localSha)
    })

    it('resets owner worktree to captured remote OID without update-ref', async () => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()
      gitMock.mockImplementation(async (args: string[]) => {
        if (args[0] === 'check-ref-format') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
          return { stdout: 'remote-oid\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return { stdout: 'old-local-oid\n', stderr: '' }
        }
        if (args[0] === 'merge-base') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'worktree') {
          return {
            stdout: 'worktree /repo\nHEAD old-local-oid\nbranch refs/heads/main\n',
            stderr: ''
          }
        }
        if (args[0] === 'status') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'reset') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      })

      await expect(
        localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: '/repo',
          fullRef: 'refs/heads/main',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).resolves.toBeUndefined()

      expect(gitMock).toHaveBeenCalledWith(
        ['merge-base', '--is-ancestor', 'old-local-oid', 'remote-oid'],
        '/repo'
      )
      expect(gitMock).toHaveBeenCalledWith(['reset', '--hard', 'remote-oid'], '/repo')
      expect(gitMock.mock.calls.map((call) => call[0])).not.toContainEqual([
        'update-ref',
        'refs/heads/main',
        'remote-oid',
        'old-local-oid'
      ])
    })

    it('fails closed when worktree ownership cannot be listed', async () => {
      const { localDispatcher, gitMock } = setupMockedRefreshHandler()
      gitMock.mockImplementation(async (args: string[]) => {
        if (args[0] === 'check-ref-format') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
          return { stdout: 'remote-oid\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return { stdout: 'old-local-oid\n', stderr: '' }
        }
        if (args[0] === 'merge-base') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'worktree') {
          throw new Error('worktree list failed')
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      })

      await expect(
        localDispatcher.callRequest('git.refreshLocalBaseRefForWorktreeCreate', {
          repoPath: '/repo',
          fullRef: 'refs/heads/main',
          remoteTrackingRef: 'refs/remotes/origin/main'
        })
      ).rejects.toThrow('worktree list failed')

      expect(gitMock.mock.calls.map((call) => call[0])).not.toContainEqual([
        'update-ref',
        'refs/heads/main',
        'refs/remotes/origin/main',
        'old-local-oid'
      ])
      expect(gitMock.mock.calls.map((call) => call[0])).not.toContainEqual([
        'reset',
        '--hard',
        'refs/heads/main'
      ])
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

    it('qualifies slash-containing local branch names when no remote ref matches', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockRejectedValueOnce(new Error('no remote ref')) // rev-parse refs/remotes/release/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }) // rev-parse refs/heads/release/main^{commit}
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // config --local --replace-all branch.<branch>.base
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get unset
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --local set

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/release',
        targetDir: '/relay/wt',
        base: 'release/main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/release/main^{commit}'],
        ['rev-parse', '--verify', '--quiet', 'refs/heads/release/main^{commit}'],
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/release',
          '/relay/wt',
          'refs/heads/release/main'
        ],
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/release.base',
          'refs/heads/release/main'
        ],
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
