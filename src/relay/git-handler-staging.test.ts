/**
 * Tests for GitHandler commit and bulk-staging operations.
 *
 * Why: split from git-handler.test.ts to stay under the oxlint max-lines (300) limit.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher
} from './git-handler-test-setup'

describe('GitHandler — commit & staging', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-staging-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    ctx.registerRoot(tmpDir)
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as never, ctx)
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
  })
})
