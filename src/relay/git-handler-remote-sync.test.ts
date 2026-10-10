/**
 * GitHandler remote synchronization RPCs: upstream divergence, fetch, fork
 * sync, fast-forward, and the narrow review-head fetches for GitHub pull
 * requests and GitLab merge requests.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { reviewHeadRemoteRefComponent } from '../shared/review-head-tracking-ref'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir,
  type GitSpyTarget
} from './git-handler-test-harness'

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string
  let gitTarget: GitSpyTarget

  beforeEach(() => {
    tmpDir = createGitTempDir()
    const relay = createGitHandlerRelay()
    dispatcher = relay.dispatcher
    gitTarget = relay.handler as unknown as GitSpyTarget
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  describe('remote operations', () => {
    it('returns upstream divergence for tracked branches', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      const result = (await dispatcher.callRequest('git.upstreamStatus', {
        worktreePath: tmpDir
      })) as { hasUpstream: boolean; upstreamName?: string; ahead: number; behind: number }

      expect(result.hasUpstream).toBe(false)
      expect(result.ahead).toBe(0)
      expect(result.behind).toBe(0)
    })

    it('reports ahead/behind counts against a real upstream remote', async () => {
      // Why: exercise the configured-upstream happy path (rev-parse HEAD@{u} + rev-list --left-right) the no-upstream test misses.
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })

        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'initial')
        const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()

        execFileSync('git', ['remote', 'add', 'origin', bareDir], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        // Juggle local commits/resets to produce specific ahead/behind counts vs. upstream.
        writeFileSync(path.join(tmpDir, 'ahead1.txt'), 'a1')
        gitCommit(tmpDir, 'ahead1')
        writeFileSync(path.join(tmpDir, 'ahead2.txt'), 'a2')
        gitCommit(tmpDir, 'ahead2')
        // Push so remote is at ahead2 (so after we reset below, we are behind).
        execFileSync('git', ['push', 'origin', branch], { cwd: tmpDir, stdio: 'pipe' })
        // Reset local back to the first commit: 0 ahead, 2 behind.
        execFileSync('git', ['reset', '--hard', firstSha], { cwd: tmpDir, stdio: 'pipe' })

        const result = (await dispatcher.callRequest('git.upstreamStatus', {
          worktreePath: tmpDir
        })) as { hasUpstream: boolean; upstreamName?: string; ahead: number; behind: number }

        expect(result.hasUpstream).toBe(true)
        expect(result.upstreamName).toBe(`origin/${branch}`)
        expect(result.ahead).toBe(0)
        expect(result.behind).toBe(2)
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('reports ahead/behind counts against a configured local-branch upstream', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const baseRef = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      execFileSync('git', ['branch', '--set-upstream-to', baseRef], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature')
      gitCommit(tmpDir, 'feature commit')

      const result = (await dispatcher.callRequest('git.upstreamStatus', {
        worktreePath: tmpDir
      })) as { hasUpstream: boolean; upstreamName?: string; ahead: number; behind: number }

      expect(result.hasUpstream).toBe(true)
      expect(result.upstreamName).toBe(baseRef)
      expect(result.ahead).toBe(1)
      expect(result.behind).toBe(0)
    })

    it('fetches from a configured remote without throwing', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })

        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'initial')
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        await expect(
          dispatcher.callRequest('git.fetch', { worktreePath: tmpDir })
        ).resolves.not.toThrow()

        // FETCH_HEAD exists only after a successful fetch, confirming the remote was actually contacted.
        await expect(fs.access(path.join(tmpDir, '.git', 'FETCH_HEAD'))).resolves.toBeUndefined()
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('rebases from the original fork point after a remote force-push', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-rebase-bare-'))
      const producerParent = mkdtempSync(path.join(tmpdir(), 'relay-git-rebase-producer-'))
      const producerDir = path.join(producerParent, 'repo')
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'base')
        const branch = execFileSync('git', ['branch', '--show-current'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        const forkPoint = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })
        execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        execFileSync('git', ['clone', bareDir, producerDir], { stdio: 'pipe' })
        execFileSync('git', ['checkout', branch], { cwd: producerDir, stdio: 'pipe' })
        execFileSync('git', ['config', 'user.email', 'test@test.com'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: producerDir, stdio: 'pipe' })
        writeFileSync(path.join(producerDir, 'discarded.txt'), 'discarded')
        gitCommit(producerDir, 'discarded remote commit')
        execFileSync('git', ['push'], { cwd: producerDir, stdio: 'pipe' })
        execFileSync('git', ['fetch', 'origin'], { cwd: tmpDir, stdio: 'pipe' })

        execFileSync('git', ['checkout', '-b', 'feature', `origin/${branch}`], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        writeFileSync(path.join(tmpDir, 'topic.txt'), 'topic')
        gitCommit(tmpDir, 'topic commit')

        execFileSync('git', ['reset', '--hard', forkPoint], { cwd: producerDir, stdio: 'pipe' })
        writeFileSync(path.join(producerDir, 'replacement.txt'), 'replacement')
        gitCommit(producerDir, 'replacement remote commit')
        execFileSync('git', ['push', '--force', 'origin', branch], {
          cwd: producerDir,
          stdio: 'pipe'
        })

        await dispatcher.callRequest('git.rebaseFromBase', {
          worktreePath: tmpDir,
          baseRef: `origin/${branch}`
        })

        await expect(fs.access(path.join(tmpDir, 'replacement.txt'))).resolves.toBeUndefined()
        await expect(fs.access(path.join(tmpDir, 'topic.txt'))).resolves.toBeUndefined()
        await expect(fs.access(path.join(tmpDir, 'discarded.txt'))).rejects.toThrow()
        expect(
          execFileSync('git', ['rev-parse', `origin/${branch}`], {
            cwd: tmpDir,
            encoding: 'utf-8'
          }).trim()
        ).toBe(
          execFileSync('git', ['rev-parse', branch], {
            cwd: producerDir,
            encoding: 'utf-8'
          }).trim()
        )
        expect(
          execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orca/rebase'], {
            cwd: tmpDir,
            encoding: 'utf-8'
          }).trim()
        ).toBe('')
      } finally {
        await Promise.all([
          fs.rm(bareDir, { recursive: true, force: true }),
          fs.rm(producerParent, { recursive: true, force: true })
        ])
      }
    }, 15_000)

    it('rebases the selected linked worktree without moving the source worktree', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-linked-rebase-bare-'))
      const producerParent = mkdtempSync(path.join(tmpdir(), 'relay-git-linked-rebase-producer-'))
      const producerDir = path.join(producerParent, 'repo')
      const targetParent = mkdtempSync(path.join(tmpdir(), 'relay-git-linked-rebase-target-'))
      const targetDir = path.join(targetParent, 'feature')
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'base')
        const baseBranch = execFileSync('git', ['branch', '--show-current'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })
        execFileSync('git', ['push', '--set-upstream', 'origin', baseBranch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['worktree', 'add', '-b', 'feature', targetDir, 'HEAD'], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        writeFileSync(path.join(targetDir, 'topic.txt'), 'topic')
        gitCommit(targetDir, 'topic')
        writeFileSync(path.join(tmpDir, 'source-dirty.txt'), 'leave me alone')
        const sourceHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        const sourceStatusBefore = execFileSync('git', ['status', '--short'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        })

        execFileSync('git', ['clone', bareDir, producerDir], { stdio: 'pipe' })
        execFileSync('git', ['config', 'user.email', 'test@test.com'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: producerDir, stdio: 'pipe' })
        execFileSync('git', ['checkout', baseBranch], { cwd: producerDir, stdio: 'pipe' })
        writeFileSync(path.join(producerDir, 'latest.txt'), 'latest')
        gitCommit(producerDir, 'latest base')
        const latestBaseOid = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: producerDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['push', 'origin', baseBranch], { cwd: producerDir, stdio: 'pipe' })

        await dispatcher.callRequest('git.rebaseFromBase', {
          worktreePath: targetDir,
          baseRef: `origin/${baseBranch}`
        })

        expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir }).toString().trim()).toBe(
          sourceHeadBefore
        )
        expect(execFileSync('git', ['status', '--short'], { cwd: tmpDir, encoding: 'utf-8' })).toBe(
          sourceStatusBefore
        )
        expect(
          execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: targetDir, encoding: 'utf-8' }).trim()
        ).toBe(latestBaseOid)
        expect(
          execFileSync('git', ['reflog', '-1', '--format=%gs'], {
            cwd: targetDir,
            encoding: 'utf-8'
          })
        ).toContain('rebase (finish)')
        expect(
          execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orca/rebase'], {
            cwd: targetDir,
            encoding: 'utf-8'
          }).trim()
        ).toBe('')
      } finally {
        await Promise.all([
          fs.rm(bareDir, { recursive: true, force: true }),
          fs.rm(producerParent, { recursive: true, force: true }),
          fs.rm(targetParent, { recursive: true, force: true })
        ])
      }
    }, 15_000)

    it('fast-forwards an unborn branch from the selected remote base', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-unborn-bare-'))
      const producerDir = mkdtempSync(path.join(tmpdir(), 'relay-git-unborn-producer-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(producerDir)
        writeFileSync(path.join(producerDir, 'base.txt'), 'base')
        gitCommit(producerDir, 'base')
        const branch = execFileSync('git', ['branch', '--show-current'], {
          cwd: producerDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', 'origin', branch], { cwd: producerDir, stdio: 'pipe' })

        gitInit(tmpDir)
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })

        await dispatcher.callRequest('git.rebaseFromBase', {
          worktreePath: tmpDir,
          baseRef: `origin/${branch}`
        })

        await expect(fs.access(path.join(tmpDir, 'base.txt'))).resolves.toBeUndefined()
        expect(execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: tmpDir })).toBeTruthy()
      } finally {
        await Promise.all([
          fs.rm(bareDir, { recursive: true, force: true }),
          fs.rm(producerDir, { recursive: true, force: true })
        ])
      }
    })

    it('cancels the active rebase fetch and still removes its private ref', async () => {
      const controller = new AbortController()
      let rejectFetch!: (error: Error) => void
      const fetchStarted = new Promise<void>((resolve) => {
        vi.spyOn(gitTarget, 'git').mockImplementation(async (args, _cwd, options) => {
          if (args[0] === 'remote') {
            return { stdout: 'origin\n', stderr: '' }
          }
          if (args[0] === 'merge-base') {
            return { stdout: 'fork-point\n', stderr: '' }
          }
          if (args[0] === 'fetch') {
            resolve()
            return new Promise((_resolve, reject) => {
              rejectFetch = reject
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            })
          }
          return { stdout: '', stderr: '' }
        })
      })

      const request = dispatcher.callRequest(
        'git.rebaseFromBase',
        { worktreePath: tmpDir, baseRef: 'origin/main' },
        { isStale: () => false, signal: controller.signal }
      )
      await fetchStarted
      controller.abort()
      await expect(request).rejects.toThrow('aborted')

      const calls = vi.mocked(gitTarget.git).mock.calls
      expect(calls.some(([args]) => args[0] === 'rebase')).toBe(false)
      const cleanup = calls.find(([args]) => args[0] === 'update-ref')
      expect(cleanup).toBeDefined()
      expect(cleanup?.[2]?.signal).toBeUndefined()
      expect(rejectFetch).toBeTypeOf('function')
    })

    it('fetches the explicit publish target remote', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-fork-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })

        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'initial')
        execFileSync('git', ['remote', 'add', 'fork', bareDir], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', 'fork', 'HEAD:feature/fix'], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        await expect(
          dispatcher.callRequest('git.fetch', {
            worktreePath: tmpDir,
            pushTarget: { remoteName: 'fork', branchName: 'feature/fix' }
          })
        ).resolves.not.toThrow()

        await expect(fs.access(path.join(tmpDir, '.git', 'FETCH_HEAD'))).resolves.toBeUndefined()
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('fast-forwards the tracked branch with ff-only pull semantics', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-bare-'))
      const producerParent = mkdtempSync(path.join(tmpdir(), 'relay-git-producer-'))
      const producerDir = path.join(producerParent, 'repo')
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })

        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'initial')
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        execFileSync('git', ['clone', bareDir, producerDir], { stdio: 'pipe' })
        execFileSync('git', ['config', 'user.email', 'test@test.com'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['config', 'user.name', 'Test'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        writeFileSync(path.join(producerDir, 'remote.txt'), 'remote')
        gitCommit(producerDir, 'remote commit')
        execFileSync('git', ['push', 'origin', branch], {
          cwd: producerDir,
          stdio: 'pipe'
        })

        await dispatcher.callRequest('git.fastForward', { worktreePath: tmpDir })

        await expect(fs.readFile(path.join(tmpDir, 'remote.txt'), 'utf-8')).resolves.toBe('remote')
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
        await fs.rm(producerParent, { recursive: true, force: true })
      }
    })

    it('rejects malformed fork sync expected upstream metadata', async () => {
      await expect(
        dispatcher.callRequest('git.forkSync', {
          worktreePath: tmpDir,
          expectedUpstream: { owner: '   ', repo: 'orca' }
        })
      ).rejects.toThrow('Invalid expected upstream.')
    })

    it('rejects fork sync requests without expected upstream metadata', async () => {
      await expect(
        dispatcher.callRequest('git.forkSync', {
          worktreePath: tmpDir
        })
      ).rejects.toThrow('Expected upstream is required.')
    })

    it('aborts fork sync when the relay request is canceled', async () => {
      gitInit(tmpDir)
      const controller = new AbortController()
      controller.abort()

      await expect(
        dispatcher.callRequest(
          'git.forkSync',
          { worktreePath: tmpDir, expectedUpstream: { owner: 'stablyai', repo: 'orca' } },
          { isStale: () => false, signal: controller.signal }
        )
      ).rejects.toThrow(/abort/i)
    })

    it('refreshes one remote-tracking ref from a configured remote', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-git-bare-'))
      const producerParent = mkdtempSync(path.join(tmpdir(), 'relay-git-producer-'))
      const producerDir = path.join(producerParent, 'repo')
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })

        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
        gitCommit(tmpDir, 'initial')
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], {
          cwd: tmpDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        execFileSync('git', ['clone', bareDir, producerDir], { stdio: 'pipe' })
        execFileSync('git', ['config', 'user.email', 'test@test.com'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        execFileSync('git', ['config', 'user.name', 'Test'], {
          cwd: producerDir,
          stdio: 'pipe'
        })
        writeFileSync(path.join(producerDir, 'base.txt'), 'updated')
        gitCommit(producerDir, 'remote update')
        execFileSync('git', ['push', 'origin', branch], { cwd: producerDir, stdio: 'pipe' })
        const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: producerDir,
          encoding: 'utf-8'
        }).trim()

        await dispatcher.callRequest('git.fetchRemoteTrackingRef', {
          worktreePath: tmpDir,
          remote: 'origin',
          branch,
          ref: `refs/remotes/origin/${branch}`
        })

        const actual = execFileSync('git', ['rev-parse', `refs/remotes/origin/${branch}`], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(actual).toBe(expected)
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
        await fs.rm(producerParent, { recursive: true, force: true })
      }
    })

    it('rejects remote-tracking refreshes that target a different ref', async () => {
      gitInit(tmpDir)
      execFileSync('git', ['remote', 'add', 'origin', tmpDir], { cwd: tmpDir, stdio: 'pipe' })

      await expect(
        dispatcher.callRequest('git.fetchRemoteTrackingRef', {
          worktreePath: tmpDir,
          remote: 'origin',
          branch: 'main',
          ref: 'refs/remotes/origin/other'
        })
      ).rejects.toThrow('Remote-tracking ref does not match the requested remote and branch.')
    })

    it('fetches GitHub pull request heads through the narrow fetch RPC', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-github-pr-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'pr.txt'), 'head')
        gitCommit(tmpDir, 'pr head')
        const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })
        execFileSync('git', ['push', 'origin', 'HEAD:refs/pull/42/head'], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        const result = (await dispatcher.callRequest('git.fetchGitHubPullRequestHead', {
          worktreePath: tmpDir,
          remote: 'origin',
          prNumber: 42
        })) as { localRef: string }

        // The ref is scoped by remote identity so soft-keep can never serve
        // another project's PR #42 out of the same object database.
        const component = reviewHeadRemoteRefComponent('origin', bareDir)
        expect(result.localRef).toBe(`refs/orca/pull/${component}/42`)
        const actual = execFileSync('git', ['rev-parse', '--verify', result.localRef], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(actual).toBe(expected)
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('rejects invalid GitHub pull request head fetch requests', async () => {
      await expect(
        dispatcher.callRequest('git.fetchGitHubPullRequestHead', {
          worktreePath: tmpDir,
          remote: '-origin',
          prNumber: 42
        })
      ).rejects.toThrow('GitHub pull request fetch remote must not start with "-".')
      await expect(
        dispatcher.callRequest('git.fetchGitHubPullRequestHead', {
          worktreePath: tmpDir,
          remote: 'origin',
          prNumber: 0
        })
      ).rejects.toThrow('Invalid GitHub pull request fetch request.')
    })

    it('fetches GitLab merge request heads through the narrow fetch RPC', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-gitlab-mr-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'mr.txt'), 'head')
        gitCommit(tmpDir, 'mr head')
        const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })
        execFileSync('git', ['push', 'origin', 'HEAD:refs/merge-requests/42/head'], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        const result = (await dispatcher.callRequest('git.fetchGitLabMergeRequestHead', {
          worktreePath: tmpDir,
          remote: 'origin',
          mrIid: 42
        })) as { localRef: string }

        // The head is fetched into a dedicated ref (not shared FETCH_HEAD) so a
        // concurrent fetch can't retarget the caller's rev-parse of the checkout.
        const component = reviewHeadRemoteRefComponent('origin', bareDir)
        expect(result.localRef).toBe(`refs/orca/merge-requests/${component}/42`)
        const actual = execFileSync('git', ['rev-parse', '--verify', result.localRef], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(actual).toBe(expected)
        // Legacy contract: pre-durable-ref desktop clients call this method name
        // and then resolve FETCH_HEAD, which a refspec fetch still writes.
        const fetchHead = execFileSync('git', ['rev-parse', '--verify', 'FETCH_HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(fetchHead).toBe(expected)
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('fetches GitLab merge request heads through the versioned durable-ref RPC', async () => {
      const bareDir = mkdtempSync(path.join(tmpdir(), 'relay-gitlab-mr-ref-bare-'))
      try {
        execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' })
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'mr.txt'), 'head')
        gitCommit(tmpDir, 'mr head')
        const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: tmpDir, stdio: 'pipe' })
        execFileSync('git', ['push', 'origin', 'HEAD:refs/merge-requests/77/head'], {
          cwd: tmpDir,
          stdio: 'pipe'
        })

        // Why: new clients call the versioned name; old relays 404 it and prompt reconnect.
        const result = (await dispatcher.callRequest('git.fetchGitLabMergeRequestHeadRef', {
          worktreePath: tmpDir,
          remote: 'origin',
          mrIid: 77
        })) as { localRef: string }

        const component = reviewHeadRemoteRefComponent('origin', bareDir)
        expect(result.localRef).toBe(`refs/orca/merge-requests/${component}/77`)
        const actual = execFileSync('git', ['rev-parse', '--verify', result.localRef], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(actual).toBe(expected)
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('rejects invalid GitLab merge request head fetch requests', async () => {
      await expect(
        dispatcher.callRequest('git.fetchGitLabMergeRequestHead', {
          worktreePath: tmpDir,
          remote: '-origin',
          mrIid: 42
        })
      ).rejects.toThrow('GitLab merge request fetch remote must not start with "-".')
      await expect(
        dispatcher.callRequest('git.fetchGitLabMergeRequestHead', {
          worktreePath: tmpDir,
          remote: 'origin',
          mrIid: 0
        })
      ).rejects.toThrow('Invalid GitLab merge request fetch request.')
    })

    it('rethrows upstreamStatus failures that are not "no upstream configured"', async () => {
      // Why: the catch only swallows "no upstream"; other errors must surface so auth/corruption failures aren't masked.
      const nonRepoDir = path.join(tmpDir, 'not-a-repo')
      await fs.mkdir(nonRepoDir, { recursive: true })

      await expect(
        dispatcher.callRequest('git.upstreamStatus', { worktreePath: nonRepoDir })
      ).rejects.toThrow(/not a git repository/i)
    })
  })
})
