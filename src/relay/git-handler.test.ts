/* eslint-disable max-lines */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import * as fs from 'fs/promises'
import * as path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
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
    expect(methods).toContain('git.upstreamStatus')
    expect(methods).toContain('git.fetch')
    expect(methods).toContain('git.push')
    expect(methods).toContain('git.pull')
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

    // Why: regression for issue #1503 — git's default core.quotePath=true
    // emits non-ASCII paths as octal-escaped, double-quoted strings (e.g.
    // "docs/\346\227\245\346\234\254\350\252\236/sample.md"), which made the
    // sidebar show gibberish and broke downstream blob reads.
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

    // Why: regression for issue #1503 on the porcelain v2 type-1 entry parser
    // branch (tracked + modified). The existing UTF-8 test exercises only the
    // untracked '?' branch; this one exercises the path-reconstruction code in
    // parseStatusOutput that joins parts.slice(8).
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

    // Why: regression for issue #1503 on the branch-diff path. Without
    // -c core.quotePath=false the diff --name-status output is octal-escaped,
    // which broke the "Committed on branch" file list.
    it('preserves UTF-8 paths in branch-compare entries', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      // Capture the default branch name before switching, so the test works
      // regardless of whether git's init.defaultBranch is master or main.
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
  })

  describe('branchDiff', () => {
    // Why: regression for issue #1503 on git.branchDiff. The branchCompare test
    // covers loadBranchChanges in git-handler.ts, but branchDiffEntries in
    // git-handler-ops.ts is a separate code path that also passes
    // -c core.quotePath=false and must round-trip UTF-8.
    it('preserves UTF-8 paths in branch-diff entries', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      const baseRef = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      const utf8Dir = path.join(tmpDir, 'docs', '日本語')
      mkdirSync(utf8Dir, { recursive: true })
      writeFileSync(path.join(utf8Dir, 'sample.md'), 'hello')
      gitCommit(tmpDir, 'feature commit')

      const result = (await dispatcher.callRequest('git.branchDiff', {
        worktreePath: tmpDir,
        baseRef,
        filePath: 'docs/日本語/sample.md'
      })) as Record<string, unknown>[]

      // Without includePatch, branchDiffEntries returns one stub entry per
      // changed file. Asserting length===1 confirms the filter matched the
      // raw UTF-8 path emitted by `git diff --name-status` — if quotePath
      // were left at default, the entry's path would be the octal-quoted
      // form and the filter at git-handler-ops.ts:230-237 would not match.
      expect(result).toHaveLength(1)
    })
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
      // Why: the upstream branch exists but isn't configured — exercise the
      // full path through `git rev-parse HEAD@{u}` + `rev-list --left-right`
      // so a future refactor can't silently break the happy-path roundtrip
      // the no-upstream test doesn't cover.
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

        // Add two local commits (ahead=2), then reset behind the remote tip
        // and add one different commit so we end up ahead=1, behind=0 vs.
        // upstream; then reset to first commit to produce behind=1 ahead=0.
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

        // FETCH_HEAD is created by any successful fetch, confirming the
        // remote was actually contacted (not just silently no-op'd).
        await expect(fs.access(path.join(tmpDir, '.git', 'FETCH_HEAD'))).resolves.toBeUndefined()
      } finally {
        await fs.rm(bareDir, { recursive: true, force: true })
      }
    })

    it('rethrows upstreamStatus failures that are not "no upstream configured"', async () => {
      // Why: the handler's catch is narrowed to only swallow the expected
      // "no upstream" signal. A non-repo path should surface its error rather
      // than silently returning hasUpstream=false, which would mask auth or
      // corruption failures in production.
      const nonRepoDir = path.join(tmpDir, 'not-a-repo')
      await fs.mkdir(nonRepoDir, { recursive: true })

      await expect(
        dispatcher.callRequest('git.upstreamStatus', { worktreePath: nonRepoDir })
      ).rejects.toThrow(/not a git repository/i)
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
