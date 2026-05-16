/* eslint-disable max-lines -- Why: this file covers ~14 distinct relay git
   handlers plus the addWorktree state machine (--no-track + push.autoSetupRemote
   probe/write across four flow branches). Splitting per-handler would scatter
   related coverage without a meaningful boundary. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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
    expect(methods).toContain('git.bulkDiscard')
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
        entries: Record<string, unknown>[]
      }
      const untracked = result.entries.find((e) => e.path === 'new.txt')
      expect(untracked).toBeDefined()
      expect(untracked!.status).toBe('untracked')
      expect(untracked!.area).toBe('untracked')
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

  describe('addWorktree', () => {
    // Why: relay handler tests for addWorktree use a mock-injection approach
    // to deterministically control git exit codes (in particular `--get` exit
    // 1 vs other non-zero codes) without relying on the test host's global
    // git config. Mirrors the pattern in src/main/git/worktree.test.ts.
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
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // --get
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --local set

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/test',
        targetDir: '/relay/wt',
        base: 'origin/main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/relay/wt', 'origin/main'],
        ['config', '--get', 'push.autoSetupRemote'],
        ['config', '--local', 'push.autoSetupRemote', 'true']
      ])
      // cwd for worktree add is repoPath; cwd for config calls is targetDir.
      expect(gitMock.mock.calls[0]?.[1]).toBe('/relay/repo')
      expect(gitMock.mock.calls[1]?.[1]).toBe('/relay/wt')
      expect(gitMock.mock.calls[2]?.[1]).toBe('/relay/wt')
    })

    it('preserves an existing push.autoSetupRemote value (does not overwrite user-set false)', async () => {
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' }) // --get returns value

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/preserve',
        targetDir: '/relay/wt',
        base: 'main'
      })

      // No --local set: --get succeeded so we preserve the user's value.
      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['worktree', 'add', '--no-track', '-b', 'feature/preserve', '/relay/wt', 'main'],
        ['config', '--get', 'push.autoSetupRemote']
      ])
    })

    it('treats --get success with empty stdout as "already set" (key present but blank)', async () => {
      // Why: `git config --get key` exits 0 if the key has any value at any
      // scope, including an explicitly empty string. We must not fall through
      // to `--local set true` and overwrite that. Mirrors the local addWorktree
      // parity case in src/main/git/worktree.test.ts.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // --get success, empty value

      await localDispatcher.callRequest('git.addWorktree', {
        repoPath: '/relay/repo',
        branchName: 'feature/empty',
        targetDir: '/relay/wt',
        base: 'main'
      })

      expect(gitMock.mock.calls.map((c) => c[0])).toEqual([
        ['worktree', 'add', '--no-track', '-b', 'feature/empty', '/relay/wt', 'main'],
        ['config', '--get', 'push.autoSetupRemote']
      ])
    })

    it('does not write --local when --get fails with non-unset code (corrupt config)', async () => {
      // Why: exit 1 from `git config --get` means "key unset" — anything else
      // is a real read failure (parse error, locked file). We must NOT fall
      // through to `--local set true`, which would silently overwrite
      // whatever value the user actually has.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
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
        ['worktree', 'add', '--no-track', '-b', 'feature/corrupt', '/relay/wt', 'main'],
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
      gitMock.mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add
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

    it('does not probe or write config when worktree add itself fails', async () => {
      // Why: a refactor that moves the config block earlier could try to
      // probe against a worktree directory that was never created. Pin the
      // ordering invariant: config calls happen only after worktree add
      // succeeds.
      const { localDispatcher, gitMock } = setupMockedHandler(['/relay/repo', '/relay/wt'])
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
        ['worktree', 'add', '--no-track', '-b', 'feature/fail', '/relay/wt', 'main']
      ])
    })
  })
})
