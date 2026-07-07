/* eslint-disable max-lines -- Why: this file covers ~14 distinct relay git
   handlers plus the addWorktree state machine (--no-track + push.autoSetupRemote
   probe/write across four flow branches). Splitting per-handler would scatter
   related coverage without a meaningful boundary. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '../shared/large-diff-render-limit'
import { removeGitFixtureDir } from '../shared/git-fixture-cleanup'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

type GitBufferSpyTarget = {
  gitBuffer(args: string[], cwd: string): Promise<Buffer>
}

type GitSpyTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

function deferredRelayBuffer(content: string): {
  promise: Promise<Buffer>
  resolve: () => void
} {
  let resolve!: (value: Buffer) => void
  const promise = new Promise<Buffer>((innerResolve) => {
    resolve = innerResolve
  })
  return {
    promise,
    resolve: () => resolve(Buffer.from(content))
  }
}

async function waitForSpyCalls(mock: ReturnType<typeof vi.fn>, calls: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= calls) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    await removeGitFixtureDir(tmpDir)
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

  function normalizeGitFileText(content: string): string {
    return content.replace(/\r\n/g, '\n')
  }

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('git.status')
    expect(methods).toContain('git.checkIgnored')
    expect(methods).toContain('git.history')
    expect(methods).toContain('git.commit')
    expect(methods).toContain('git.diff')
    expect(methods).toContain('git.stage')
    expect(methods).toContain('git.unstage')
    expect(methods).toContain('git.bulkStage')
    expect(methods).toContain('git.bulkUnstage')
    expect(methods).toContain('git.abortMerge')
    expect(methods).toContain('git.abortRebase')
    expect(methods).toContain('git.checkout')
    expect(methods).toContain('git.localBranches')
    expect(methods).toContain('git.discard')
    expect(methods).toContain('git.bulkDiscard')
    expect(methods).toContain('git.conflictOperation')
    expect(methods).toContain('git.branchCompare')
    expect(methods).toContain('git.upstreamStatus')
    expect(methods).toContain('git.fetch')
    expect(methods).toContain('git.forkSync')
    expect(methods).toContain('git.addUpstreamRemote')
    expect(methods).toContain('git.fetchRemoteTrackingRef')
    expect(methods).toContain('git.fetchGitLabMergeRequestHead')
    expect(methods).toContain('git.push')
    expect(methods).toContain('git.pull')
    expect(methods).toContain('git.fastForward')
    expect(methods).toContain('git.rebaseFromBase')
    expect(methods).toContain('git.branchDiff')
    expect(methods).toContain('git.listWorktrees')
    expect(methods).toContain('git.addWorktree')
    expect(methods).toContain('git.removeWorktree')
    expect(methods).toContain('git.worktreeIsClean')
    expect(methods).toContain('git.refreshLocalBaseRefForWorktreeCreate')
    expect(methods).toContain('git.renameCurrentBranch')
    expect(methods).toContain('git.forceDeletePreservedBranch')
    expect(methods).toContain('git.exec')
    expect(methods).toContain('git.clone')
    expect(methods).toContain('git.isGitRepo')
  })

  describe('abortMerge', () => {
    it('aborts an in-progress merge', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'feature\n')
      gitCommit(tmpDir, 'feature change')
      execFileSync('git', ['checkout', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'main\n')
      gitCommit(tmpDir, 'main change')

      expect(() =>
        execFileSync('git', ['merge', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      ).toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'MERGE_HEAD'))).resolves.toBeUndefined()

      await dispatcher.callRequest('git.abortMerge', { worktreePath: tmpDir })

      await expect(fs.access(path.join(tmpDir, '.git', 'MERGE_HEAD'))).rejects.toThrow()
      await expect(
        fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8').then(normalizeGitFileText)
      ).resolves.toBe('main\n')
    })
  })

  describe('abortRebase', () => {
    it('aborts an in-progress rebase', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'feature\n')
      gitCommit(tmpDir, 'feature change')
      execFileSync('git', ['checkout', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'file.txt'), 'main\n')
      gitCommit(tmpDir, 'main change')
      execFileSync('git', ['checkout', 'feature'], { cwd: tmpDir, stdio: 'pipe' })

      expect(() =>
        execFileSync('git', ['rebase', baseBranch], { cwd: tmpDir, stdio: 'pipe' })
      ).toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-merge'))).resolves.toBeUndefined()

      await dispatcher.callRequest('git.abortRebase', { worktreePath: tmpDir })

      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-merge'))).rejects.toThrow()
      await expect(fs.access(path.join(tmpDir, '.git', 'rebase-apply'))).rejects.toThrow()
      await expect(
        fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8').then(normalizeGitFileText)
      ).resolves.toBe('feature\n')
    })
  })

  describe('checkout / localBranches', () => {
    it('switches to an existing local branch and lists branches current-first', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'base\n')
      gitCommit(tmpDir, 'initial')
      const baseBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      execFileSync('git', ['branch', 'feature'], { cwd: tmpDir, stdio: 'pipe' })

      const before = (await dispatcher.callRequest('git.localBranches', {
        worktreePath: tmpDir
      })) as { current: string | null; branches: string[] }
      expect(before.current).toBe(baseBranch)
      expect(before.branches).toContain('feature')
      expect(before.branches[0]).toBe(baseBranch)

      await dispatcher.callRequest('git.checkout', { worktreePath: tmpDir, branch: 'feature' })

      expect(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: tmpDir,
          encoding: 'utf-8',
          stdio: 'pipe'
        }).trim()
      ).toBe('feature')

      const after = (await dispatcher.callRequest('git.localBranches', {
        worktreePath: tmpDir
      })) as { current: string | null; branches: string[] }
      expect(after.current).toBe('feature')
      expect(after.branches[0]).toBe('feature')
    })
  })

  describe('renameCurrentBranch', () => {
    it('renames only the checked-out branch through the narrow RPC', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['checkout', '-b', 'you/Nautilus'], { cwd: tmpDir })

      await dispatcher.callRequest('git.renameCurrentBranch', {
        worktreePath: tmpDir,
        newBranch: 'you/fix-auth'
      })

      const current = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(current).toBe('you/fix-auth')
    })

    it('rejects branch names that look like flags', async () => {
      gitInit(tmpDir)
      await expect(
        dispatcher.callRequest('git.renameCurrentBranch', {
          worktreePath: tmpDir,
          newBranch: '-bad'
        })
      ).rejects.toThrow('Branch name must not start with "-"')
    })
  })

  describe('forceDeletePreservedBranch', () => {
    function headOf(cwd: string, ref: string): string {
      return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf-8' }).trim()
    }

    it('deletes a preserved branch at its expected head through the narrow RPC', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      execFileSync('git', ['branch', 'feature/preserved'], { cwd: tmpDir, stdio: 'pipe' })
      const head = headOf(tmpDir, 'refs/heads/feature/preserved')

      await dispatcher.callRequest('git.forceDeletePreservedBranch', {
        repoPath: tmpDir,
        branchName: 'feature/preserved',
        expectedHead: head
      })

      const refs = execFileSync('git', ['branch', '--list', 'feature/preserved'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(refs).toBe('')
    })

    it('refuses to delete when the branch moved past the expected head', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      const staleHead = headOf(tmpDir, 'HEAD')
      execFileSync('git', ['checkout', '-b', 'feature/preserved'], { cwd: tmpDir, stdio: 'pipe' })
      // Advance the branch so the saved (stale) head no longer matches its tip.
      gitCommit(tmpDir, 'second')
      execFileSync('git', ['checkout', '-'], { cwd: tmpDir, stdio: 'pipe' })

      await expect(
        dispatcher.callRequest('git.forceDeletePreservedBranch', {
          repoPath: tmpDir,
          branchName: 'feature/preserved',
          expectedHead: staleHead
        })
      ).rejects.toThrow('changed after the workspace was deleted')
      const refs = execFileSync('git', ['branch', '--list', 'feature/preserved'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(refs).toContain('feature/preserved')
    })

    it('rejects an empty repoPath at the RPC boundary', async () => {
      await expect(
        dispatcher.callRequest('git.forceDeletePreservedBranch', {
          repoPath: '',
          branchName: 'feature/preserved',
          expectedHead: 'abc123'
        })
      ).rejects.toThrow('Invalid preserved branch force-delete request.')
    })
  })

  describe('history', () => {
    it('returns bounded git history for a repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      gitCommit(tmpDir, 'second')

      const result = (await dispatcher.callRequest('git.history', {
        worktreePath: tmpDir,
        limit: 10
      })) as {
        items: { subject: string; displayId?: string }[]
        currentRef?: { category?: string; revision?: string }
        hasMore: boolean
        limit: number
      }

      expect(result.items.map((item) => item.subject)).toEqual(['second', 'initial'])
      expect(result.currentRef?.category).toBe('branches')
      expect(result.currentRef?.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(result.items[0]?.displayId).toHaveLength(7)
      expect(result.hasMore).toBe(false)
      expect(result.limit).toBe(10)
    })
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
      await Promise.all(extraDirs.splice(0).map((dir) => removeGitFixtureDir(dir)))
    })

    // Why: `git submodule add` against a local path is blocked since git 2.38
    // unless protocol.file.allow=always is set explicitly.
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

    // Why: a moved gitlink with a clean submodule worktree has no uncommitted
    // rows, so status/diff must surface the committed file changes between the
    // recorded and checked-out commits.
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
        await removeGitFixtureDir(outsideDir)
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
        await removeGitFixtureDir(outsideDir)
      }
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

  describe('branchDiff', () => {
    it('coalesces concurrent identical git.diff reads while in flight and reads fresh after settle', async () => {
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: true
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)

      gitBufferSpy
        .mockResolvedValueOnce(Buffer.from('fresh-left\n'))
        .mockResolvedValueOnce(Buffer.from('fresh-right\n'))

      await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: true
      })

      expect(gitBufferSpy).toHaveBeenCalledTimes(4)
    })

    it('clears pending git.diff reads when status runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockResolvedValue({ stdout: '', stderr: '' })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.status', { worktreePath: tmpDir })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalled()
    })

    it('clears pending git.diff reads when a mutation runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockResolvedValue({ stdout: '', stderr: '' })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.stage', { worktreePath: tmpDir, filePath: 'src/file.ts' })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledWith(['add', '--', 'src/file.ts'], tmpDir)
    })

    it('clears pending git.diff reads when a narrow ref fetch runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'remote') {
            return { stdout: 'origin\n', stderr: '' }
          }
          return { stdout: '', stderr: '' }
        })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.fetchRemoteTrackingRef', {
        worktreePath: tmpDir,
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main'
      })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledWith(
        ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        tmpDir
      )
    })

    it('coalesces concurrent identical git.branchDiff reads while in flight', async () => {
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'rev-parse' && args.includes('HEAD')) {
            return { stdout: `${'c'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse') {
            return { stdout: `${'b'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base') {
            return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
          }
          if (args.includes('--name-status')) {
            return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`)
        })
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: true,
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledTimes(4)
    })

    it('coalesces concurrent identical git.commitDiff reads while in flight', async () => {
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
    })

    it('coalesces parentless root git.commitDiff reads without a left-side blob', async () => {
      const rightBlob = deferredRelayBuffer('right\n')
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => rightBlob.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: null,
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      rightBlob.resolve()
      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(1)
    })

    it('keeps distinct relay diff keys independent', async () => {
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockResolvedValue(Buffer.from('blob\n'))

      await Promise.all([
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: true
        }),
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: false,
          compareAgainstHead: true
        })
      ])

      expect(gitBufferSpy).toHaveBeenCalledTimes(3)

      gitBufferSpy.mockClear()
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'rev-parse' && args.includes('HEAD')) {
            return { stdout: `${'c'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse' && args.includes('develop')) {
            return { stdout: `${'d'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse') {
            return { stdout: `${'b'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base' && args.includes('d'.repeat(40))) {
            return { stdout: `${'e'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base') {
            return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
          }
          if (args.includes('--name-status')) {
            return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`)
        })

      await Promise.all([
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: true,
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: false,
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'develop',
          includePatch: true,
          filePath: 'src/file.ts'
        })
      ])

      expect(gitSpy).toHaveBeenCalledTimes(12)
      expect(gitBufferSpy).toHaveBeenCalledTimes(4)

      gitBufferSpy.mockClear()

      await Promise.all([
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'a'.repeat(40),
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts',
          oldPath: 'src/old-a.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts',
          oldPath: 'src/old-b.ts'
        })
      ])

      expect(gitBufferSpy).toHaveBeenCalledTimes(8)
    })

    it('retries relay diff reads after an in-flight rejection settles', async () => {
      const invalidRequest = {
        worktreePath: tmpDir,
        commitOid: 'not-a-full-oid',
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      }
      const first = dispatcher.callRequest('git.commitDiff', invalidRequest)
      const firstBurst = [
        first,
        ...Array.from({ length: 7 }, () => dispatcher.callRequest('git.commitDiff', invalidRequest))
      ]

      await expect(Promise.all(firstBurst)).rejects.toThrow(
        'commitOid must be a full git object id'
      )

      const retry = dispatcher.callRequest('git.commitDiff', invalidRequest)
      expect(retry).not.toBe(first)
      await expect(retry).rejects.toThrow('commitOid must be a full git object id')
    })

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
        await removeGitFixtureDir(bareDir)
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

        // FETCH_HEAD is created by any successful fetch, confirming the
        // remote was actually contacted (not just silently no-op'd).
        await expect(fs.access(path.join(tmpDir, '.git', 'FETCH_HEAD'))).resolves.toBeUndefined()
      } finally {
        await removeGitFixtureDir(bareDir)
      }
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
        await removeGitFixtureDir(bareDir)
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
        await removeGitFixtureDir(bareDir)
        await removeGitFixtureDir(producerParent)
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

    it('adds the upstream remote mirroring the origin transport and is idempotent', async () => {
      gitInit(tmpDir)
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/tebayoso/orca.git'], {
        cwd: tmpDir,
        stdio: 'pipe'
      })

      const result = (await dispatcher.callRequest('git.addUpstreamRemote', {
        worktreePath: tmpDir,
        expectedUpstream: { owner: 'stablyai', repo: 'orca' }
      })) as { ok: boolean; url?: string; alreadyExisted?: boolean }

      expect(result).toEqual({
        ok: true,
        url: 'https://github.com/stablyai/orca.git',
        alreadyExisted: false
      })
      const upstreamUrl = execFileSync('git', ['remote', 'get-url', 'upstream'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim()
      expect(upstreamUrl).toBe('https://github.com/stablyai/orca.git')

      const again = (await dispatcher.callRequest('git.addUpstreamRemote', {
        worktreePath: tmpDir,
        expectedUpstream: { owner: 'stablyai', repo: 'orca' }
      })) as { ok: boolean; alreadyExisted?: boolean }
      expect(again).toMatchObject({ ok: true, alreadyExisted: true })
    })

    it('refuses to overwrite an existing upstream remote pointing elsewhere', async () => {
      gitInit(tmpDir)
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/tebayoso/orca.git'], {
        cwd: tmpDir,
        stdio: 'pipe'
      })
      execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/someone/else.git'], {
        cwd: tmpDir,
        stdio: 'pipe'
      })

      const result = (await dispatcher.callRequest('git.addUpstreamRemote', {
        worktreePath: tmpDir,
        expectedUpstream: { owner: 'stablyai', repo: 'orca' }
      })) as { ok: boolean; reason?: string }

      expect(result).toEqual({ ok: false, reason: 'upstream-exists-mismatch' })
    })

    it('rejects malformed add-upstream expected upstream metadata', async () => {
      await expect(
        dispatcher.callRequest('git.addUpstreamRemote', {
          worktreePath: tmpDir,
          expectedUpstream: { owner: '   ', repo: 'orca' }
        })
      ).rejects.toThrow('Invalid expected upstream.')
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
        await removeGitFixtureDir(bareDir)
        await removeGitFixtureDir(producerParent)
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

        await dispatcher.callRequest('git.fetchGitLabMergeRequestHead', {
          worktreePath: tmpDir,
          remote: 'origin',
          mrIid: 42
        })

        const actual = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        }).trim()
        expect(actual).toBe(expected)
      } finally {
        await removeGitFixtureDir(bareDir)
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

    it.skipIf(process.platform === 'win32')(
      'normalizes the main worktree path for a separate-git-dir repo',
      async () => {
        const sourcePath = path.join(tmpDir, 'source')
        const worktreePath = path.join(tmpDir, 'worktree')
        const gitDirPath = path.join(tmpDir, 'git-store', 'project.git')
        mkdirSync(sourcePath)
        mkdirSync(path.dirname(gitDirPath), { recursive: true })
        gitInit(sourcePath)
        writeFileSync(path.join(sourcePath, 'file.txt'), 'hello')
        gitCommit(sourcePath, 'initial')

        execFileSync('git', [
          'clone',
          '--quiet',
          `--separate-git-dir=${gitDirPath}`,
          sourcePath,
          worktreePath
        ])

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: await fs.realpath(worktreePath)
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(worktreePath),
          isMainWorktree: true
        })
        expect(mainWorktree?.path).not.toBe(await fs.realpath(gitDirPath))
      }
    )

    it.skipIf(process.platform === 'win32')(
      'leaves an ordinary repo reached via a symlinked path unchanged',
      async () => {
        // A symlink alias defeats the path-string gate (git reports the
        // realpath toplevel); the git-common-dir gate must still skip the
        // rewrite for an ordinary repo so the reported path is untouched.
        const repoPath = path.join(tmpDir, 'plain-repo')
        mkdirSync(repoPath)
        gitInit(repoPath)
        writeFileSync(path.join(repoPath, 'file.txt'), 'hello')
        gitCommit(repoPath, 'initial')
        const linkedRepoPath = path.join(tmpDir, 'linked-repo')
        symlinkSync(repoPath, linkedRepoPath)

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: linkedRepoPath
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(repoPath),
          isMainWorktree: true
        })
      }
    )

    it.skipIf(process.platform === 'win32')(
      'leaves the main entry unchanged when scanned via a linked worktree',
      async () => {
        // A linked worktree has a `.git` pointer file like a separate-git-dir
        // checkout, but its porcelain main entry is the real main working root.
        // The git-common-dir gate must skip the rewrite so the main entry is
        // not overwritten with the linked worktree's own toplevel.
        const repoPath = path.join(tmpDir, 'main-repo')
        mkdirSync(repoPath)
        gitInit(repoPath)
        writeFileSync(path.join(repoPath, 'file.txt'), 'hello')
        gitCommit(repoPath, 'initial')
        const linkedWorktreePath = path.join(tmpDir, 'linked-wt')
        execFileSync('git', ['worktree', 'add', '--quiet', linkedWorktreePath, '-b', 'feature'], {
          cwd: repoPath,
          stdio: 'pipe'
        })
        const resolvedLinked = await fs.realpath(linkedWorktreePath)

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: resolvedLinked
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(repoPath),
          isMainWorktree: true
        })
        expect(mainWorktree?.path).not.toBe(resolvedLinked)
      }
    )

    it.skipIf(process.platform === 'win32')(
      'lists worktrees whose paths contain newlines',
      async () => {
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
        gitCommit(tmpDir, 'initial')
        const worktreePath = path.join(
          path.dirname(tmpDir),
          `${path.basename(tmpDir)}-linked\nremote`
        )

        try {
          execFileSync(
            'git',
            ['worktree', 'add', '--quiet', '-b', 'feature/newline', worktreePath],
            {
              cwd: tmpDir,
              stdio: 'pipe'
            }
          )
          const realWorktreePath = await fs.realpath(worktreePath)

          const result = (await dispatcher.callRequest('git.listWorktrees', {
            repoPath: tmpDir
          })) as Record<string, unknown>[]

          expect(result.map((worktree) => worktree.path)).toContain(realWorktreePath)
        } finally {
          await removeGitFixtureDir(worktreePath)
        }
      }
    )
  })

  describe('worktreeIsClean', () => {
    it('can ignore untracked files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'tracked.txt'), 'initial')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'scratch.txt'), 'untracked')

      await expect(
        dispatcher.callRequest('git.worktreeIsClean', { worktreePath: tmpDir })
      ).resolves.toEqual({
        clean: false,
        stdout: expect.stringContaining('scratch.txt')
      })
      await expect(
        dispatcher.callRequest('git.worktreeIsClean', {
          worktreePath: tmpDir,
          includeUntracked: false
        })
      ).resolves.toEqual({ clean: true })
    })
  })

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
      // Why: repos that fetch with --tags can end up with a local tag named
      // 'main', making `git worktree add ... main` fail with "fatal: Ambiguous
      // object name". Qualifying as refs/heads/main tells git exactly which
      // object to use.
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
      // Why: `git config --get key` exits 0 if the key has any value at any
      // scope, including an explicitly empty string. We must not fall through
      // to `--local set true` and overwrite that. Mirrors the local addWorktree
      // parity case in src/main/git/worktree.test.ts.
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
      // Why: exit 1 from `git config --get` means "key unset" — anything else
      // is a real read failure (parse error, locked file). We must NOT fall
      // through to `--local set true`, which would silently overwrite
      // whatever value the user actually has.
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
      // Why: a refactor that moves the config block earlier could try to
      // probe config against a worktree directory that was never created. Pin
      // the ordering invariant: config calls happen only after worktree add succeeds.
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
