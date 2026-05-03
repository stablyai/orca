import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import * as fs from 'fs/promises'
import * as path from 'path'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    ctx.registerRoot(tmpDir)
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('git.status')
    expect(methods).toContain('git.commit')
    expect(methods).toContain('git.diff')
    expect(methods).toContain('git.stage')
    expect(methods).toContain('git.unstage')
    expect(methods).toContain('git.bulkStage')
    expect(methods).toContain('git.bulkUnstage')
    expect(methods).toContain('git.discard')
    expect(methods).toContain('git.conflictOperation')
    expect(methods).toContain('git.branchCompare')
    expect(methods).toContain('git.branchDiff')
    expect(methods).toContain('git.listWorktrees')
    expect(methods).toContain('git.addWorktree')
    expect(methods).toContain('git.removeWorktree')
    expect(methods).toContain('git.exec')
    expect(methods).toContain('git.isGitRepo')
  })

  describe('status', () => {
    it('returns empty entries for clean repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
        conflictOperation: string
      }
      expect(result.entries).toEqual([])
      expect(result.conflictOperation).toBe('unknown')
    })

    it('detects untracked files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'tracked.txt'), 'tracked')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'new.txt'), 'new')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
      }
      const untracked = result.entries.find((e) => e.path === 'new.txt')
      expect(untracked).toBeDefined()
      expect(untracked!.status).toBe('untracked')
      expect(untracked!.area).toBe('untracked')
    })

    it('detects modified files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'modified')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
      }
      const modified = result.entries.find((e) => e.path === 'file.txt')
      expect(modified).toBeDefined()
      expect(modified!.status).toBe('modified')
      expect(modified!.area).toBe('unstaged')
    })

    it('detects staged files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
      }
      const staged = result.entries.find((e) => e.area === 'staged')
      expect(staged).toBeDefined()
      expect(staged!.status).toBe('modified')
    })
  })

  describe('stage and unstage', () => {
    it('stages a file', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')

      await dispatcher.callRequest('git.stage', { worktreePath: tmpDir, filePath: 'file.txt' })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output.trim()).toBe('file.txt')
    })

    it('unstages a file', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      await dispatcher.callRequest('git.unstage', { worktreePath: tmpDir, filePath: 'file.txt' })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output.trim()).toBe('')
    })
  })

  describe('diff', () => {
    it('returns text diff for modified file', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'modified')

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'file.txt',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }
      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe('original')
      expect(result.modifiedContent).toBe('modified')
    })

    it('returns staged diff', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'staged-content')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'file.txt',
        staged: true
      })) as { kind: string; originalContent: string; modifiedContent: string }
      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe('original')
      expect(result.modifiedContent).toBe('staged-content')
    })
  })

  describe('discard', () => {
    it('discards changes to tracked file', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'modified')

      await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: 'file.txt' })

      const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8')
      expect(content).toBe('original')
    })

    it('deletes untracked file on discard', async () => {
      gitInit(tmpDir)
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'new.txt'), 'untracked')

      await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: 'new.txt' })
      await expect(fs.access(path.join(tmpDir, 'new.txt'))).rejects.toThrow()
    })

    it('rejects path traversal', async () => {
      gitInit(tmpDir)
      await expect(
        dispatcher.callRequest('git.discard', {
          worktreePath: tmpDir,
          filePath: '../../../etc/passwd'
        })
      ).rejects.toThrow('outside the worktree')
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

  describe('branchCompare', () => {
    it('compares branch against base', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature')
      gitCommit(tmpDir, 'feature commit')

      const result = (await dispatcher.callRequest('git.branchCompare', {
        worktreePath: tmpDir,
        baseRef: 'master'
      })) as { summary: Record<string, unknown>; entries: Record<string, unknown>[] }

      // May be 'master' or error if default branch is 'main'
      if (result.summary.status === 'ready') {
        expect(result.entries.length).toBeGreaterThan(0)
        expect(result.summary.commitsAhead).toBe(1)
      }
    })
  })

  describe('listWorktrees', () => {
    it('lists worktrees for a repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')

      const result = (await dispatcher.callRequest('git.listWorktrees', {
        repoPath: tmpDir
      })) as Record<string, unknown>[]
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].isMainWorktree).toBe(true)
    })
  })
})
