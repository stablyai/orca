/**
 * Tests for GitHandler commit and staging operations.
 *
 * Why: split from git-handler.test.ts to stay under the oxlint max-lines (300) limit.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const PATHSPEC_SELECTED_FILE = '[k]eep.log'
const PATHSPEC_MATCHING_FILE = 'keep.log'
const PATHSPEC_MUTATION_CASES = [
  {
    mode: 'single-file',
    stageMethod: 'git.stage',
    unstageMethod: 'git.unstage',
    selection: { filePath: PATHSPEC_SELECTED_FILE }
  },
  {
    mode: 'bulk',
    stageMethod: 'git.bulkStage',
    unstageMethod: 'git.bulkUnstage',
    selection: { filePaths: [PATHSPEC_SELECTED_FILE] }
  }
] as const

function createPathspecCollisionChanges(dir: string): void {
  gitInit(dir)
  writeFileSync(path.join(dir, PATHSPEC_SELECTED_FILE), 'selected')
  writeFileSync(path.join(dir, PATHSPEC_MATCHING_FILE), 'matching')
  gitCommit(dir, 'initial')
  writeFileSync(path.join(dir, PATHSPEC_SELECTED_FILE), 'selected modified')
  writeFileSync(path.join(dir, PATHSPEC_MATCHING_FILE), 'matching modified')
}

describe('GitHandler — commit & staging', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-staging-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
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

  describe('stage and unstage', () => {
    it.each(PATHSPEC_MUTATION_CASES)(
      'treats $mode stage paths with Git glob characters as literals',
      async ({ stageMethod, selection }) => {
        createPathspecCollisionChanges(tmpDir)

        await dispatcher.callRequest(stageMethod, { worktreePath: tmpDir, ...selection })

        const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        })
        expect(output.trim()).toBe(PATHSPEC_SELECTED_FILE)
      }
    )

    it.each(PATHSPEC_MUTATION_CASES)(
      'treats $mode unstage paths with Git glob characters as literals',
      async ({ unstageMethod, selection }) => {
        createPathspecCollisionChanges(tmpDir)
        execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })

        await dispatcher.callRequest(unstageMethod, { worktreePath: tmpDir, ...selection })

        const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        })
        expect(output.trim()).toBe(PATHSPEC_MATCHING_FILE)
      }
    )

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
  })
})
