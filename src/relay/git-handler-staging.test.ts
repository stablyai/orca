/**
 * Tests for GitHandler commit and bulk-staging operations.
 *
 * Why: split from git-handler.test.ts to stay under the oxlint max-lines (300) limit.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

type GitSpyTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

describe('GitHandler — commit & staging', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-staging-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('commit', () => {
    it('commits staged changes and returns success', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.commit', {
        worktreePath: tmpDir,
        message: 'feat: relay commit'
      })) as { success: boolean; error?: string }

      expect(result).toEqual({ success: true })
      const latestMessage = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(latestMessage).toBe('feat: relay commit')
    })

    // Why: covers the error-extraction path in commitChangesRelay
    // (git-handler-worktree-ops.ts). Running `git commit` with nothing staged
    // exits non-zero and writes a "nothing to commit" message; we assert the
    // relay surfaces a non-empty error string so the UI can display it.
    it('returns a non-empty error when the commit fails', async () => {
      gitInit(tmpDir)

      const result = (await dispatcher.callRequest('git.commit', {
        worktreePath: tmpDir,
        message: 'no changes'
      })) as { success: boolean; error?: string }

      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
      expect((result.error ?? '').length).toBeGreaterThan(0)
      // Why: exact phrasing can vary across git versions, so match the
      // stable substring "nothing" rather than the full "nothing to commit".
      expect((result.error ?? '').toLowerCase()).toContain('nothing')
    })
  })

  describe('bulkStage and bulkUnstage', () => {
    it('stages multiple files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')

      writeFileSync(path.join(tmpDir, 'a.txt'), 'a-modified')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b-modified')

      await dispatcher.callRequest('git.bulkStage', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt']
      })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output).toContain('a.txt')
      expect(output).toContain('b.txt')
    })

    it('unstages multiple files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')

      writeFileSync(path.join(tmpDir, 'a.txt'), 'changed')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'changed')
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })

      await dispatcher.callRequest('git.bulkUnstage', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt']
      })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output.trim()).toBe('')
    })

    it('normalizes Windows separators before bulk staging nested files', async () => {
      gitInit(tmpDir)
      mkdirSync(path.join(tmpDir, 'tests', 'breakgit'), { recursive: true })
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'a.txt'), 'a-modified')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'b.txt'), 'b-modified')

      const gitHarness = handler as unknown as GitSpyTarget
      const originalGit = gitHarness.git.bind(handler) as GitSpyTarget['git']
      const gitSpy = vi
        .spyOn(gitHarness, 'git')
        .mockImplementation((args, cwd) => originalGit(args, cwd))

      await dispatcher.callRequest('git.bulkStage', {
        worktreePath: tmpDir,
        filePaths: ['tests\\breakgit\\a.txt', 'tests\\breakgit\\b.txt']
      })

      expect(gitSpy).toHaveBeenCalledWith(
        ['add', '--', ':(literal)tests/breakgit/a.txt', ':(literal)tests/breakgit/b.txt'],
        tmpDir
      )
      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output).toContain('tests/breakgit/a.txt')
      expect(output).toContain('tests/breakgit/b.txt')
    })

    it('normalizes Windows separators before bulk unstaging nested files', async () => {
      gitInit(tmpDir)
      mkdirSync(path.join(tmpDir, 'tests', 'breakgit'), { recursive: true })
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'a.txt'), 'changed')
      writeFileSync(path.join(tmpDir, 'tests', 'breakgit', 'b.txt'), 'changed')
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })

      const gitHarness = handler as unknown as GitSpyTarget
      const originalGit = gitHarness.git.bind(handler) as GitSpyTarget['git']
      const gitSpy = vi
        .spyOn(gitHarness, 'git')
        .mockImplementation((args, cwd) => originalGit(args, cwd))

      await dispatcher.callRequest('git.bulkUnstage', {
        worktreePath: tmpDir,
        filePaths: ['tests\\breakgit\\a.txt', 'tests\\breakgit\\b.txt']
      })

      expect(gitSpy).toHaveBeenCalledWith(
        [
          'restore',
          '--staged',
          '--',
          ':(literal)tests/breakgit/a.txt',
          ':(literal)tests/breakgit/b.txt'
        ],
        tmpDir
      )
      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output.trim()).toBe('')
    })
  })
})
