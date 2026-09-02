/**
 * GitHandler working-tree change reporting and mutation: status entries,
 * ignored-path checks, stage/unstage, and discard (single + bulk).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
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

  describe('status', () => {
    it('returns empty entries for clean repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
        conflictOperation: string
        head?: string
        branch?: string
      }
      expect(result.entries).toEqual([])
      expect(result.conflictOperation).toBe('unknown')
      expect(result.branch).toMatch(/^refs\/heads\//)
      expect(typeof result.head).toBe('string')
    })

    it('detects untracked files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'tracked.txt'), 'tracked')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'new.txt'), 'new')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: {
          path?: unknown
          status?: unknown
          area?: unknown
          added?: unknown
          removed?: unknown
        }[]
      }
      const untracked = result.entries.find((e) => e.path === 'new.txt')
      expect(untracked).toBeDefined()
      expect(untracked!.status).toBe('untracked')
      expect(untracked!.area).toBe('untracked')
      expect(untracked!.added).toBe(1)
      expect(untracked!.removed).toBeUndefined()
    })

    it('returns ignored paths only when requested', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n.env\n')
      gitCommit(tmpDir, 'initial')
      mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
      writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'compiled')
      writeFileSync(path.join(tmpDir, '.env'), 'TOKEN=secret')

      const defaultResult = (await dispatcher.callRequest('git.status', {
        worktreePath: tmpDir
      })) as {
        ignoredPaths?: string[]
      }
      const ignoredResult = (await dispatcher.callRequest('git.status', {
        worktreePath: tmpDir,
        includeIgnored: true
      })) as {
        ignoredPaths?: string[]
      }

      expect('ignoredPaths' in defaultResult).toBe(false)
      expect(ignoredResult.ignoredPaths).toEqual(expect.arrayContaining(['dist/', '.env']))
    })

    it('checks ignored status for selected paths', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n.env\n')
      gitCommit(tmpDir, 'initial')
      mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
      writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'compiled')
      writeFileSync(path.join(tmpDir, '.env'), 'TOKEN=secret')

      const result = (await dispatcher.callRequest('git.checkIgnored', {
        worktreePath: tmpDir,
        paths: ['dist/bundle.js', 'src/index.ts', '.env']
      })) as string[]

      expect(result).toEqual(expect.arrayContaining(['dist/bundle.js', '.env']))
      expect(result).not.toContain('src/index.ts')
    })

    it('detects modified files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'modified')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: {
          path?: unknown
          status?: unknown
          area?: unknown
          added?: unknown
          removed?: unknown
        }[]
      }
      const modified = result.entries.find((e) => e.path === 'file.txt')
      expect(modified).toBeDefined()
      expect(modified!.status).toBe('modified')
      expect(modified!.area).toBe('unstaged')
      expect(modified!.added).toBe(1)
      expect(modified!.removed).toBe(1)
    })

    it('detects staged files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: {
          path?: unknown
          status?: unknown
          area?: unknown
          added?: unknown
          removed?: unknown
        }[]
      }
      const staged = result.entries.find((e) => e.area === 'staged')
      expect(staged).toBeDefined()
      expect(staged!.status).toBe('modified')
      expect(staged!.added).toBe(1)
      expect(staged!.removed).toBe(1)
    })

    // Why: regression for #1503 — default core.quotePath=true octal-escapes non-ASCII paths (breaks sidebar + blob reads).
    it('preserves UTF-8 paths in status output', async () => {
      gitInit(tmpDir)
      const utf8Dir = path.join(tmpDir, 'docs', '日本語')
      mkdirSync(utf8Dir, { recursive: true })
      writeFileSync(path.join(utf8Dir, 'sample.md'), 'hello')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
      }
      const entry = result.entries.find((e) =>
        typeof e.path === 'string' ? e.path.endsWith('sample.md') : false
      )
      expect(entry).toBeDefined()
      expect(entry!.path).toBe('docs/日本語/sample.md')
    })

    // Why: regression for #1503 on the porcelain v2 type-1 (tracked+modified) parser branch, which the untracked '?' test misses.
    it('preserves UTF-8 paths for tracked-modified entries', async () => {
      gitInit(tmpDir)
      const utf8Dir = path.join(tmpDir, 'docs', '日本語')
      mkdirSync(utf8Dir, { recursive: true })
      const utf8File = path.join(utf8Dir, 'sample.md')
      writeFileSync(utf8File, 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(utf8File, 'modified')

      const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir })) as {
        entries: Record<string, unknown>[]
      }
      const entry = result.entries.find((e) =>
        typeof e.path === 'string' ? e.path.endsWith('sample.md') : false
      )
      expect(entry).toBeDefined()
      expect(entry!.path).toBe('docs/日本語/sample.md')
      expect(entry!.status).toBe('modified')
      expect(entry!.area).toBe('unstaged')
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

    it('treats untracked discard paths with Git glob characters as literal paths', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored.log\n')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, '[k]eep.log'), 'selected')
      writeFileSync(path.join(tmpDir, 'keep.log'), 'unrelated')
      writeFileSync(path.join(tmpDir, 'ignored.log'), 'ignored')

      await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: '[k]eep.log' })

      await expect(fs.access(path.join(tmpDir, '[k]eep.log'))).rejects.toThrow()
      await expect(fs.access(path.join(tmpDir, 'keep.log'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(tmpDir, 'ignored.log'))).resolves.toBeUndefined()
    })

    it('treats tracked discard paths with Git glob characters as literal paths', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, '[k]eep.log'), 'selected')
      writeFileSync(path.join(tmpDir, 'keep.log'), 'keep')
      gitCommit(tmpDir, 'track log fixtures')
      writeFileSync(path.join(tmpDir, '[k]eep.log'), 'selected modified')
      writeFileSync(path.join(tmpDir, 'keep.log'), 'keep modified')

      await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: '[k]eep.log' })

      await expect(fs.readFile(path.join(tmpDir, '[k]eep.log'), 'utf-8')).resolves.toBe('selected')
      await expect(fs.readFile(path.join(tmpDir, 'keep.log'), 'utf-8')).resolves.toBe(
        'keep modified'
      )
    })

    it('bulk discards tracked and untracked files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a-modified')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b-modified')
      writeFileSync(path.join(tmpDir, 'new.txt'), 'untracked')

      await dispatcher.callRequest('git.bulkDiscard', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt', 'new.txt']
      })

      await expect(fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8')).resolves.toBe('a')
      await expect(fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).resolves.toBe('b')
      await expect(fs.access(path.join(tmpDir, 'new.txt'))).rejects.toThrow()
    })

    it('handles large tracked path lists during bulk discard classification', async () => {
      const trackedStdout = Array.from({ length: 150_000 }, (_, index) => `docs/file-${index}.ts`)
        .join('\0')
        .concat('\0')
      const gitMock = vi
        .spyOn(
          handler as unknown as {
            git: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
          },
          'git'
        )
        .mockResolvedValueOnce({ stdout: trackedStdout, stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })

      await dispatcher.callRequest('git.bulkDiscard', {
        worktreePath: tmpDir,
        filePaths: ['docs']
      })

      expect(gitMock).toHaveBeenNthCalledWith(
        2,
        ['restore', '--worktree', '--source=HEAD', '--', ':(literal)docs'],
        tmpDir
      )
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

    it('rejects bulk discard path traversal', async () => {
      gitInit(tmpDir)
      await expect(
        dispatcher.callRequest('git.bulkDiscard', {
          worktreePath: tmpDir,
          filePaths: ['file.txt', '../../../etc/passwd']
        })
      ).rejects.toThrow('outside the worktree')
    })

    it('rejects untracked child paths through symlinked parents', async () => {
      gitInit(tmpDir)
      gitCommit(tmpDir, 'initial')
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'relay-git-outside-'))
      const outsideFile = path.join(outsideDir, 'keep.txt')
      writeFileSync(outsideFile, 'outside')
      symlinkSync(
        outsideDir,
        path.join(tmpDir, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )

      try {
        await expect(
          dispatcher.callRequest('git.discard', {
            worktreePath: tmpDir,
            filePath: 'link/keep.txt'
          })
        ).rejects.toThrow('outside the worktree')
        await expect(fs.access(outsideFile)).resolves.toBeUndefined()
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('rejects bulk untracked child paths through symlinked parents before deleting anything', async () => {
      gitInit(tmpDir)
      gitCommit(tmpDir, 'initial')
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'relay-git-outside-'))
      const outsideFile = path.join(outsideDir, 'keep.txt')
      const untrackedFile = path.join(tmpDir, 'new.txt')
      writeFileSync(outsideFile, 'outside')
      writeFileSync(untrackedFile, 'untracked')
      symlinkSync(
        outsideDir,
        path.join(tmpDir, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )

      try {
        await expect(
          dispatcher.callRequest('git.bulkDiscard', {
            worktreePath: tmpDir,
            filePaths: ['new.txt', 'link/keep.txt']
          })
        ).rejects.toThrow('outside the worktree')
        await expect(fs.access(outsideFile)).resolves.toBeUndefined()
        await expect(fs.access(untrackedFile)).resolves.toBeUndefined()
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true })
      }
    })
  })
})
