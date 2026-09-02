/**
 * GitHandler per-file diff payloads: worktree/staged diffs, submodule diff and
 * status routing, and branch-compare entries.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '../shared/large-diff-render-limit'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  normalizeGitFileText,
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

    it('omits over-limit text bodies before returning diff payloads', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      const oversizedText = 'a'.repeat(MAX_RENDERED_DIFF_COMBINED_CHARACTERS + 1)
      writeFileSync(path.join(tmpDir, 'file.txt'), oversizedText)

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'file.txt',
        staged: false
      })) as {
        kind: string
        originalContent: string
        modifiedContent: string
        largeDiffRenderLimit?: { limited: boolean; reason?: string; characterCount?: number }
      }

      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe('')
      expect(result.modifiedContent).toBe('')
      expect(result.largeDiffRenderLimit?.limited).toBe(true)
      expect(result.largeDiffRenderLimit?.reason).toBe('character-count')
      expect(result.largeDiffRenderLimit?.characterCount).toBe(
        oversizedText.length + 'original'.length
      )
    })

    it('returns diff for tracked files in valid dot-dot-prefixed directories', async () => {
      gitInit(tmpDir)
      mkdirSync(path.join(tmpDir, '..fixtures'))
      writeFileSync(path.join(tmpDir, '..fixtures', 'file.txt'), 'original')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, '..fixtures', 'file.txt'), 'modified')

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: '..fixtures/file.txt',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }

      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe('original')
      expect(result.modifiedContent).toBe('modified')
    })

    it('rejects diff paths that traverse outside the worktree', async () => {
      gitInit(tmpDir)

      await expect(
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: '../outside.txt',
          staged: false
        })
      ).rejects.toThrow('outside the worktree')
    })
  })

  describe('submodule', () => {
    const extraDirs: string[] = []

    afterEach(async () => {
      await Promise.all(
        extraDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
      )
    })

    // Why: `git submodule add` against a local path is blocked since git 2.38 unless protocol.file.allow=always is set.
    function addSubmodule(parent: string, name: string): string {
      const src = mkdtempSync(path.join(tmpdir(), 'relay-subsrc-'))
      extraDirs.push(src)
      gitInit(src)
      writeFileSync(path.join(src, 'lib.txt'), 'v1\n')
      gitCommit(src, 'sub initial')
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', src, name], {
        cwd: parent,
        stdio: 'pipe'
      })
      execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: parent, stdio: 'pipe' })
      return path.join(parent, name)
    }

    it('returns inner per-file changes via git.submoduleStatus', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
      gitCommit(tmpDir, 'initial')
      const sub = addSubmodule(tmpDir, 'flutter_mine')
      writeFileSync(path.join(sub, 'lib.txt'), 'v2\n')

      const result = (await dispatcher.callRequest('git.submoduleStatus', {
        worktreePath: tmpDir,
        submodulePath: 'flutter_mine'
      })) as { entries: { path?: unknown; status?: unknown; area?: unknown }[] }

      const inner = result.entries.find((e) => e.path === 'lib.txt')
      expect(inner).toBeDefined()
      expect(inner!.status).toBe('modified')
      expect(inner!.area).toBe('unstaged')
    })

    it('rejects submoduleStatus paths that escape the worktree', async () => {
      gitInit(tmpDir)
      await expect(
        dispatcher.callRequest('git.submoduleStatus', {
          worktreePath: tmpDir,
          submodulePath: '../outside'
        })
      ).rejects.toThrow('outside the worktree')
    })

    it('routes inner submodule files into the submodule worktree diff', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
      gitCommit(tmpDir, 'initial')
      const sub = addSubmodule(tmpDir, 'flutter_mine')
      writeFileSync(path.join(sub, 'lib.txt'), 'v2\n')

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'flutter_mine/lib.txt',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }

      expect(result.kind).toBe('text')
      expect(normalizeGitFileText(result.originalContent)).toBe('v1\n')
      expect(normalizeGitFileText(result.modifiedContent)).toBe('v2\n')
    })

    it('synthesizes a Subproject commit pointer diff for the gitlink root', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
      gitCommit(tmpDir, 'initial')
      const sub = addSubmodule(tmpDir, 'flutter_mine')
      const oldOid = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sub,
        encoding: 'utf-8'
      }).trim()
      writeFileSync(path.join(sub, 'lib.txt'), 'v2\n')
      execFileSync('git', ['add', 'lib.txt'], { cwd: sub, stdio: 'pipe' })
      gitCommit(sub, 'sub second')
      const newOid = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sub,
        encoding: 'utf-8'
      }).trim()

      const result = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'flutter_mine',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }

      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe(`Subproject commit ${oldOid}\n`)
      expect(result.modifiedContent).toBe(`Subproject commit ${newOid}\n`)
    })

    // Why: a moved gitlink with a clean submodule has no uncommitted rows, so status/diff must surface the committed commit-range changes.
    it('lists commit-range files and diffs them when the pointer moved', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
      gitCommit(tmpDir, 'initial')
      const sub = addSubmodule(tmpDir, 'flutter_mine')
      writeFileSync(path.join(sub, 'lib.txt'), 'v2\n')
      execFileSync('git', ['add', 'lib.txt'], { cwd: sub, stdio: 'pipe' })
      gitCommit(sub, 'sub second')

      const status = (await dispatcher.callRequest('git.submoduleStatus', {
        worktreePath: tmpDir,
        submodulePath: 'flutter_mine'
      })) as { entries: { path?: unknown; status?: unknown; area?: unknown }[] }
      const ranged = status.entries.find((e) => e.path === 'lib.txt')
      expect(ranged).toBeDefined()
      expect(ranged!.status).toBe('modified')
      expect(ranged!.area).toBe('unstaged')

      const diff = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'flutter_mine/lib.txt',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }
      expect(diff.kind).toBe('text')
      expect(normalizeGitFileText(diff.originalContent)).toBe('v1\n')
      expect(normalizeGitFileText(diff.modifiedContent)).toBe('v2\n')
    })

    it('lists and diffs staged submodule pointer changes from parent HEAD to index', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
      gitCommit(tmpDir, 'initial')
      const sub = addSubmodule(tmpDir, 'flutter_mine')
      writeFileSync(path.join(sub, 'lib.txt'), 'v2\n')
      execFileSync('git', ['add', 'lib.txt'], { cwd: sub, stdio: 'pipe' })
      gitCommit(sub, 'sub second')
      execFileSync('git', ['add', 'flutter_mine'], { cwd: tmpDir, stdio: 'pipe' })

      const status = (await dispatcher.callRequest('git.submoduleStatus', {
        worktreePath: tmpDir,
        submodulePath: 'flutter_mine',
        area: 'staged'
      })) as { entries: { path?: unknown; status?: unknown; area?: unknown }[] }
      const ranged = status.entries.find((e) => e.path === 'lib.txt')
      expect(ranged).toBeDefined()
      expect(ranged!.status).toBe('modified')
      expect(ranged!.area).toBe('unstaged')

      const diff = (await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'flutter_mine/lib.txt',
        staged: true
      })) as { kind: string; originalContent: string; modifiedContent: string }
      expect(diff.kind).toBe('text')
      expect(normalizeGitFileText(diff.originalContent)).toBe('v1\n')
      expect(normalizeGitFileText(diff.modifiedContent)).toBe('v2\n')
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

    // Why: regression for #1503 on the branch-diff path; without -c core.quotePath=false diff paths are octal-escaped.
    it('preserves UTF-8 paths in branch-compare entries', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      // Capture the default branch name so the test works regardless of init.defaultBranch (master vs main).
      const baseRef = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      const utf8Dir = path.join(tmpDir, 'docs', '日本語')
      mkdirSync(utf8Dir, { recursive: true })
      writeFileSync(path.join(utf8Dir, 'sample.md'), 'hello')
      gitCommit(tmpDir, 'feature commit')

      const result = (await dispatcher.callRequest('git.branchCompare', {
        worktreePath: tmpDir,
        baseRef
      })) as { summary: Record<string, unknown>; entries: Record<string, unknown>[] }

      expect(result.summary.status).toBe('ready')
      const entry = result.entries.find((e) =>
        typeof e.path === 'string' ? e.path.endsWith('sample.md') : false
      )
      expect(entry).toBeDefined()
      expect(entry!.path).toBe('docs/日本語/sample.md')
    })

    it('treats an unborn branch with a resolvable base as having no committed branch changes', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')
      const baseRef = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '--orphan', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      execFileSync('git', ['rm', '-rf', '.'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.branchCompare', {
        worktreePath: tmpDir,
        baseRef
      })) as { summary: Record<string, unknown>; entries: Record<string, unknown>[] }

      expect(result.summary).toMatchObject({
        baseRef,
        compareRef: 'feature',
        headOid: null,
        changedFiles: 0,
        commitsAhead: 0,
        status: 'ready'
      })
      expect(result.summary.baseOid).toMatch(/^[0-9a-f]{40}$/)
      expect(result.entries).toEqual([])
    })
  })
})
