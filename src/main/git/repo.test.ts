import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import { configureRealGitTestRepo } from './real-git-test-repo'

import {
  buildSearchBaseRefsArgv,
  getBaseRefDefault,
  getBranchConflictKind,
  getRemoteCount,
  parseAndFilterSearchRefDetails,
  resolveDefaultBaseRefViaExec,
  searchBaseRefDetails,
  searchBaseRefs
} from './repo'
import {
  REPO_SEARCH_REFS_MAX_LIMIT,
  REPO_SEARCH_REFS_MAX_SCAN_LIMIT
} from '../../shared/repo-search-limits'

// Why: use real git state (not mocked) because the bug is in the for-each-ref glob shape a mock would miss.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet'])
  // Why: `--initial-branch=main` needs git >= 2.28; symbolic-ref before the first commit forces `main` on any git version.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  configureRealGitTestRepo(dir, { name: 'Test', email: 'test@test.com' })
  git(dir, ['commit', '--allow-empty', '-m', 'initial', '--quiet'])
}

/** Create a remote-tracking ref via `update-ref`, avoiding a live remote. */
function createRemoteRef(mainDir: string, shortName: string, sha: string): void {
  git(mainDir, ['update-ref', `refs/remotes/${shortName}`, sha])
}

function getHeadSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

describe('buildSearchBaseRefsArgv', () => {
  it('caps broad local ref searches before parsing results', () => {
    const argv = buildSearchBaseRefsArgv('feature', 25)

    expect(argv).toContain('--exclude=refs/remotes/*/HEAD')
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/*feature*')
    expect(argv).toContain('refs/remotes/**/*feature*/**')
  })

  it('keeps segmented display-format searches bounded', () => {
    const argv = buildSearchBaseRefsArgv('upstream/main', 10)

    expect(argv).toContain('--exclude=refs/remotes/*/HEAD')
    expect(argv).toContain('--count=40')
    expect(argv).toContain('refs/remotes/*upstream*/*main*')
    expect(argv).toContain('refs/heads/*upstream*/*main*')
    expect(argv).toContain('refs/remotes/*/upstream/main*')
    expect(argv).toContain('refs/heads/upstream/main*')
  })

  it('keeps remote HEAD excludes compact when many remotes are configured', () => {
    const ordinaryRemotes = Array.from({ length: 200 }, (_, index) => `remote-${index}`)
    const argv = buildSearchBaseRefsArgv('feature', 10, {
      remoteNames: [...ordinaryRemotes, 'origin', 'upstream', 'origin', 'foo/bar', 'foo/bar']
    })
    const excludes = argv.filter((arg) => arg.startsWith('--exclude='))

    // One wildcard handles ordinary remotes; slash-containing names need an
    // exact pattern because `*` does not cross the remote-name slash.
    expect(excludes).toEqual([
      '--exclude=refs/remotes/*/HEAD',
      '--exclude=refs/remotes/foo/bar/HEAD'
    ])
  })

  it('anchors local-branch-name searches below configured remotes', () => {
    const argv = buildSearchBaseRefsArgv('plan/docs', 10, { remoteNames: ['origin', 'foo/bar'] })

    expect(argv).toContain('refs/remotes/origin/plan/docs*')
    expect(argv).toContain('refs/remotes/foo/bar/plan/docs*')
    expect(argv).not.toContain('refs/remotes/**/*plan/docs*')
  })

  it('can build display-format and branch-root patterns separately', () => {
    const segmentedArgv = buildSearchBaseRefsArgv('upstream/feat', 10, {
      remoteNames: ['origin', 'upstream'],
      patternGroup: 'segmented'
    })
    const argv = buildSearchBaseRefsArgv('upstream/feat', 10, {
      remoteNames: ['origin', 'upstream'],
      patternGroup: 'branchRoot'
    })

    expect(segmentedArgv).toContain('refs/remotes/*upstream*/*feat*')
    expect(segmentedArgv).not.toContain('refs/remotes/origin/upstream/feat*')
    expect(argv).toContain('refs/remotes/origin/upstream/feat*')
    expect(argv).not.toContain('refs/remotes/*upstream*/*feat*')
  })

  it('adds fallback headroom when remote HEAD cannot be excluded by git', () => {
    const argv = buildSearchBaseRefsArgv('feature', 25, { excludeRemoteHead: false })

    expect(argv).not.toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=200')
  })
})

describe('searchBaseRefs (widened glob)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-test-'))
    initRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns upstream/* branches when querying a non-origin remote', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const results = await searchBaseRefs(tmpDir, 'upstream')

    expect(results).toContain('upstream/main')
  })

  it('returns both origin/* and upstream/* for a shared branch name', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/feature-x', sha)
    createRemoteRef(tmpDir, 'upstream/feature-x', sha)

    const results = await searchBaseRefs(tmpDir, 'feature-x')

    expect(results).toContain('origin/feature-x')
    expect(results).toContain('upstream/feature-x')
  })

  it('filters out <remote>/HEAD pseudo-refs for all remotes', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    createRemoteRef(tmpDir, 'upstream/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    git(tmpDir, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main'])

    const results = await searchBaseRefs(tmpDir, 'HEAD')

    expect(results).not.toContain('origin/HEAD')
    expect(results).not.toContain('upstream/HEAD')
  })

  it('is not hardcoded to `upstream` — arbitrary remote names are discoverable', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'mycorp-fork/main', sha)

    const results = await searchBaseRefs(tmpDir, 'mycorp')

    expect(results).toContain('mycorp-fork/main')
  })

  it('still returns local branches from refs/heads/*', async () => {
    git(tmpDir, ['branch', 'local-only'])

    const results = await searchBaseRefs(tmpDir, 'local')

    expect(results).toContain('local-only')
  })

  // Why: fnmatch `*` doesn't cross `/`, so a single-word query needs `**` to match any segment of a slashed name.
  it('finds a local slashed branch when the query lands in a deep segment', async () => {
    git(tmpDir, ['branch', 'feature/login'])

    const results = await searchBaseRefs(tmpDir, 'login')

    expect(results).toContain('refs/heads/feature/login')
  })

  it('finds a local slashed branch when the query lands in an ancestor segment', async () => {
    git(tmpDir, ['branch', 'feature/login'])

    const results = await searchBaseRefs(tmpDir, 'feature')

    expect(results).toContain('refs/heads/feature/login')
  })

  it('finds a remote slashed branch when the query lands in a deep segment', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/feature/login', sha)

    const results = await searchBaseRefs(tmpDir, 'login')

    expect(results).toContain('origin/feature/login')
  })

  it('finds a remote slashed branch when the query lands in an ancestor segment', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/feature/login', sha)

    const results = await searchBaseRefs(tmpDir, 'feature')

    expect(results).toContain('origin/feature/login')
  })

  it('returns the local branch name for a remote ref with slashes', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'origin/feature/something', sha)

    const results = await searchBaseRefDetails(tmpDir, 'origin/feature/something')

    expect(results).toContainEqual({
      refName: 'origin/feature/something',
      localBranchName: 'feature/something'
    })
  })

  it('keeps local branch names unchanged in detailed search results', async () => {
    git(tmpDir, ['branch', 'feature/something'])

    const results = await searchBaseRefDetails(tmpDir, 'feature/something')

    expect(results).toContainEqual({
      refName: 'refs/heads/feature/something',
      localBranchName: 'feature/something'
    })
  })

  it('recovers complete Unicode ref names when Git splits a short ref byte sequence', () => {
    const branch = 'feature/运动记录及预约详情页优化'
    const results = parseAndFilterSearchRefDetails(
      [
        `refs/heads/${branch}\0feature/运动记录及预约详�`,
        `refs/remotes/origin/${branch}\0origin/feature/运动记录及预约详�`
      ].join('\n'),
      10,
      ['origin']
    )

    expect(results).toEqual([
      { refName: `refs/heads/${branch}`, localBranchName: branch },
      { refName: `refs/remotes/origin/${branch}`, localBranchName: branch }
    ])
  })

  it('preserves namespace disambiguation while recovering colliding Unicode refs', () => {
    const branch = 'origin/feature/运动记录及预约详情页优化'
    const results = parseAndFilterSearchRefDetails(
      [
        `refs/heads/${branch}\0origin/feature/运动记录及预约详�`,
        `refs/remotes/${branch}\0origin/feature/运动记录及预约详�`
      ].join('\n'),
      10,
      ['origin']
    )

    expect(results).toEqual([
      { refName: `refs/heads/${branch}`, localBranchName: branch },
      {
        refName: `refs/remotes/${branch}`,
        localBranchName: 'feature/运动记录及预约详情页优化'
      }
    ])
  })

  it('distinguishes literal U+FFFD from a later decoder-introduced truncation marker', () => {
    const literal = 'feature/�'
    const fullyQualifiedLiteral = 'feature/fully-qualified/�'
    const truncated = 'feature/�运动记录及预约详情页优化'
    const results = parseAndFilterSearchRefDetails(
      [
        `refs/heads/${literal}\0${literal}`,
        `refs/heads/${fullyQualifiedLiteral}\0refs/heads/${fullyQualifiedLiteral}`,
        `refs/heads/${truncated}\0feature/�运动记录及预约详�`
      ].join('\n'),
      10
    )

    expect(results).toEqual([
      { refName: `refs/heads/${literal}`, localBranchName: literal },
      {
        refName: `refs/heads/${fullyQualifiedLiteral}`,
        localBranchName: fullyQualifiedLiteral
      },
      { refName: `refs/heads/${truncated}`, localBranchName: truncated }
    ])
  })

  it.each(['feature/运动记录及预约详情页优化', 'feature/运动记录及预约详情页优化加', 'feature/加'])(
    'returns intact Unicode ref names from real Git: %s',
    async (branch) => {
      const sha = getHeadSha(tmpDir)
      git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
      git(tmpDir, ['branch', branch])
      createRemoteRef(tmpDir, `origin/${branch}`, sha)

      const results = await searchBaseRefDetails(tmpDir, branch.slice('feature/'.length))

      const refNames = results.map(({ refName }) => refName)
      expect(refNames.some((ref) => ref === branch || ref === `refs/heads/${branch}`)).toBe(true)
      expect(
        refNames.some(
          (ref) => ref === `origin/${branch}` || ref === `refs/remotes/origin/${branch}`
        )
      ).toBe(true)
      expect(results.every(({ localBranchName }) => localBranchName === branch)).toBe(true)
      expect(results.every(({ refName }) => !refName.includes('\uFFFD'))).toBe(true)
      expect(
        results.every(
          ({ refName }) => git(tmpDir, ['rev-parse', '--verify', refName]).trim() === sha
        )
      ).toBe(true)
    }
  )

  it('creates worktrees from intact local and remote Unicode search selectors', async () => {
    const branch = 'feature/加'
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['branch', branch])
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, `origin/${branch}`, sha)
    const results = await searchBaseRefDetails(tmpDir, '加')
    expect(results).toHaveLength(2)
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'orca-unicode-worktrees-'))
    try {
      for (const [index, result] of results.entries()) {
        const worktreePath = path.join(worktreeRoot, String(index))
        git(tmpDir, ['worktree', 'add', '-b', `recovered-${index}`, worktreePath, result.refName])
        expect(git(worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(sha)
        expect(result.localBranchName).toBe(branch)
      }
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true })
      git(tmpDir, ['worktree', 'prune'])
    }
  })

  it.each(['feature./valid', 'feature./运动记录', 'feature./加'])(
    'keeps valid dotted components searchable: %s',
    async (branch) => {
      const sha = getHeadSha(tmpDir)
      git(tmpDir, ['branch', branch])
      git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
      createRemoteRef(tmpDir, `origin/${branch}`, sha)
      const results = await searchBaseRefDetails(tmpDir, branch)
      expect(results).toHaveLength(2)
      expect(results.every(({ localBranchName }) => localBranchName === branch)).toBe(true)
      expect(
        results.map(({ refName }) => git(tmpDir, ['rev-parse', '--verify', refName]).trim())
      ).toEqual([sha, sha])
    }
  )

  it.each([true, false])(
    'keeps colliding local and remote selectors distinct in loose mode with configured remote %s',
    async (configured) => {
      const branch = 'origin/feature'
      const localSha = getHeadSha(tmpDir)
      git(tmpDir, ['branch', branch])
      if (configured) {
        git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
      }
      git(tmpDir, ['commit', '--allow-empty', '-m', 'remote target', '--quiet'])
      const remoteSha = getHeadSha(tmpDir)
      createRemoteRef(tmpDir, branch, remoteSha)
      git(tmpDir, ['config', 'core.warnAmbiguousRefs', 'false'])
      const results = await searchBaseRefDetails(tmpDir, branch)
      expect(results).toContainEqual({ refName: `refs/heads/${branch}`, localBranchName: branch })
      for (const result of results) {
        const base = await resolveWorktreeAddBaseRef(result.refName, async (ref) => {
          try {
            git(tmpDir, ['rev-parse', '--verify', ref])
            return true
          } catch {
            return false
          }
        })
        expect(git(tmpDir, ['rev-parse', '--verify', base]).trim()).toBe(
          result.localBranchName === branch ? localSha : remoteSha
        )
      }
    }
  )

  it.each(['branch', 'tag'])(
    'preserves a nested remote HEAD against a colliding %s',
    async (kind) => {
      const remoteSha = getHeadSha(tmpDir)
      git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
      createRemoteRef(tmpDir, 'origin/feature/HEAD', remoteSha)
      git(tmpDir, ['commit', '--allow-empty', '-m', 'collision target', '--quiet'])
      git(tmpDir, [kind, 'origin/feature/HEAD'])
      const results = await searchBaseRefDetails(tmpDir, 'feature/HEAD')
      expect(results).toContainEqual({
        refName: 'refs/remotes/origin/feature/HEAD',
        localBranchName: 'feature/HEAD'
      })
      expect(
        git(tmpDir, ['rev-parse', '--verify', 'refs/remotes/origin/feature/HEAD']).trim()
      ).toBe(remoteSha)
    }
  )

  it.each(['refs/heads/topic', 'refs/remotes/origin/topic'])(
    'preserves the local namespace for a branch named %s',
    async (branch) => {
      git(tmpDir, ['branch', branch])
      const results = await searchBaseRefDetails(tmpDir, branch)
      expect(results).toEqual([{ refName: `refs/heads/${branch}`, localBranchName: branch }])
    }
  )

  it('returns distinct resolvable names for real colliding Unicode refs', async () => {
    const branch = 'origin/运动记录及预约详情页优化'
    const localSha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['branch', branch, localSha])
    git(tmpDir, ['commit', '--allow-empty', '-m', 'remote ref', '--quiet'])
    const remoteSha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, branch, remoteSha)

    const results = await searchBaseRefDetails(tmpDir, 'origin/运动')

    expect(results).toHaveLength(2)
    expect(
      Object.fromEntries(
        results.map(({ refName, localBranchName }) => [
          localBranchName,
          git(tmpDir, ['rev-parse', '--verify', refName]).trim()
        ])
      )
    ).toEqual({
      [branch]: localSha,
      运动记录及预约详情页优化: remoteSha
    })
  })

  it('resolves a Unicode branch rather than a same-name tag', async () => {
    const branch = 'feature/运动记录及预约详情页优化'
    const branchSha = getHeadSha(tmpDir)
    git(tmpDir, ['branch', branch, branchSha])
    git(tmpDir, ['commit', '--allow-empty', '-m', 'tag target', '--quiet'])
    git(tmpDir, ['tag', branch])

    const results = await searchBaseRefDetails(tmpDir, '运动记录')

    expect(results).toHaveLength(1)
    expect(results[0]?.refName).toBe(`refs/heads/${branch}`)
    expect(results[0]?.localBranchName).toBe(branch)
    expect(git(tmpDir, ['rev-parse', '--verify', results[0]?.refName ?? '']).trim()).toBe(branchSha)

    const worktreeDir = mkdtempSync(path.join(tmpdir(), 'orca-ref-worktree-test-'))
    rmSync(worktreeDir, { recursive: true })
    try {
      git(tmpDir, ['worktree', 'add', '--quiet', worktreeDir, results[0]?.localBranchName ?? ''])
      expect(git(worktreeDir, ['symbolic-ref', 'HEAD']).trim()).toBe(`refs/heads/${branch}`)
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true })
      git(tmpDir, ['worktree', 'prune'])
    }
  })

  it('allows creating a local branch from the selected matching remote base ref', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'origin/feature/something', sha)

    const result = await getBranchConflictKind(
      tmpDir,
      'feature/something',
      'origin/feature/something'
    )

    expect(result).toBeNull()
  })

  it('still reports a remote conflict for a different tracking ref with the same branch name', async () => {
    const sha = getHeadSha(tmpDir)
    // Why register both: a ref only tracks a branch when a remote actually owns its
    // prefix, and this case is about a second *tracking* ref, not an orphan.
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'upstream', 'https://example.invalid/upstream.git'])
    createRemoteRef(tmpDir, 'origin/feature/something', sha)
    createRemoteRef(tmpDir, 'upstream/feature/something', sha)

    expect(
      await getBranchConflictKind(tmpDir, 'feature/something', 'origin/feature/something')
    ).toBe('remote')
  })

  it('ignores a ref whose prefix matches no configured remote', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'mimic-fork/my-task', sha)

    expect(await getBranchConflictKind(tmpDir, 'my-task', 'origin/main')).toBeNull()
  })

  it('stops treating leftover refs from a removed remote as conflicts', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'fork', 'https://example.invalid/fork.git'])
    createRemoteRef(tmpDir, 'fork/my-task', sha)
    expect(await getBranchConflictKind(tmpDir, 'my-task', 'origin/main')).toBe('remote')

    // Why not `remote remove`: that prunes the tracking refs too, which would pass
    // with or without the ownership guard. Dropping only the config leaves the
    // orphan ref behind, which is the state this guard exists for.
    git(tmpDir, ['config', '--remove-section', 'remote.fork'])

    expect(await getBranchConflictKind(tmpDir, 'my-task', 'origin/main')).toBeNull()
  })

  it('still reports a local conflict when an unrelated ref shares the name', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'mimic-fork/my-task', sha)
    git(tmpDir, ['branch', 'my-task'])

    expect(await getBranchConflictKind(tmpDir, 'my-task', 'origin/main')).toBe('local')
  })

  it('reports remote conflicts when the remote name contains a slash', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'foo/bar', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'foo/bar/feature/something', sha)

    const result = await getBranchConflictKind(
      tmpDir,
      'feature/something',
      'origin/feature/something'
    )

    expect(result).toBe('remote')
  })

  it('keeps a remote named refs/heads distinct from a fully qualified local ref', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'refs/heads', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'refs/heads/feature-example', sha)

    const results = await searchBaseRefDetails(tmpDir, 'feature-example')

    expect(results).toContainEqual({
      refName: 'refs/remotes/refs/heads/feature-example',
      localBranchName: 'feature-example'
    })
  })

  it('uses the longest configured remote name when deriving local branch names', () => {
    const results = parseAndFilterSearchRefDetails(
      'refs/remotes/foo/bar/feature/something\u0000foo/bar/feature/something\n',
      10,
      ['foo', 'foo/bar']
    )

    expect(results).toEqual([
      {
        refName: 'foo/bar/feature/something',
        localBranchName: 'feature/something'
      }
    ])
  })

  it('returns [] for a repo with no matching refs', async () => {
    const results = await searchBaseRefs(tmpDir, 'nonexistent-query-xyz')

    expect(results).toEqual([])
  })

  it('returns recent refs for an empty query so branch pickers can open populated', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)
    createRemoteRef(tmpDir, 'upstream/feature-x', sha)

    const results = await searchBaseRefs(tmpDir, '')

    expect(results).toEqual(['main', 'upstream/feature-x', 'upstream/main'])
  })

  it('caps broad ref-search argv before git output is captured', () => {
    const argv = buildSearchBaseRefsArgv('', 12)

    expect(argv).toContain('--exclude=refs/remotes/*/HEAD')
    expect(argv).toContain('--count=48')
  })

  it('does not hard-cap large explicit ref-search limits below the request size', () => {
    const argv = buildSearchBaseRefsArgv('', 600)

    expect(argv).toContain('--count=2400')
  })

  it('clamps oversized limits before constructing an unbounded Git count', () => {
    expect(buildSearchBaseRefsArgv('', REPO_SEARCH_REFS_MAX_LIMIT)).toContain('--count=4000')
    expect(buildSearchBaseRefsArgv('', REPO_SEARCH_REFS_MAX_SCAN_LIMIT)).toContain('--count=4004')
    expect(buildSearchBaseRefsArgv('', REPO_SEARCH_REFS_MAX_SCAN_LIMIT + 1)).toContain(
      '--count=4004'
    )
    expect(buildSearchBaseRefsArgv('', Number.MAX_SAFE_INTEGER)).toContain('--count=4004')
    expect(() => buildSearchBaseRefsArgv('', Number.MAX_VALUE)).toThrow('invalid_limit')
  })

  it('rejects malformed limits instead of running an uncapped search', async () => {
    await expect(searchBaseRefs(tmpDir, '', 0.5)).resolves.toEqual([])
    await expect(searchBaseRefs(tmpDir, '', Number.NaN)).resolves.toEqual([])
    await expect(
      searchBaseRefs(tmpDir, '', REPO_SEARCH_REFS_MAX_SCAN_LIMIT + 1)
    ).resolves.toContain('main')
    await expect(searchBaseRefs(tmpDir, '', Number.MAX_SAFE_INTEGER)).resolves.toContain('main')
    await expect(searchBaseRefs(tmpDir, '', Number.MAX_VALUE)).resolves.toEqual([])
  })

  // Why: users retype the displayed `<remote>/<branch>` format, so a slashed query must still match.
  it('finds the ref when the query is in display format `<remote>/<branch>`', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const results = await searchBaseRefs(tmpDir, 'upstream/main')

    expect(results).toContain('upstream/main')
  })

  it('matches remote-and-branch prefixes with display-format queries', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/feature-x', sha)
    createRemoteRef(tmpDir, 'upstream/feature-y', sha)
    createRemoteRef(tmpDir, 'origin/feature-x', sha)

    const results = await searchBaseRefs(tmpDir, 'upstream/feat')

    expect(results).toContain('upstream/feature-x')
    expect(results).toContain('upstream/feature-y')
    // Why: `upstream/feat` pins the remote segment to *upstream*, so origin/feature-x must not leak in.
    expect(results).not.toContain('origin/feature-x')
  })

  it('does not match when tokens are in the wrong segments', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    // Why: each token is pinned to its own segment (remote vs branch), so `main/upstream` must not match `upstream/main`.
    const results = await searchBaseRefs(tmpDir, 'main/upstream')

    expect(results).not.toContain('upstream/main')
  })

  it('still filters HEAD pseudo-refs for display-format queries', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main'])

    // Why: the HEAD filter runs after the glob match, so display-format queries must still drop the pseudo-ref.
    const results = await searchBaseRefs(tmpDir, 'upstream/HEAD')

    expect(results).not.toContain('upstream/HEAD')
  })

  it('keeps nested branches whose final component is HEAD', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'upstream', 'https://example.invalid/upstream.git'])
    createRemoteRef(tmpDir, 'upstream/main', sha)
    createRemoteRef(tmpDir, 'upstream/feature/HEAD', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main'])

    const results = await searchBaseRefs(tmpDir, 'feature/HEAD')

    const nestedRef = results.find(
      (ref) => ref.endsWith('/upstream/feature/HEAD') || ref === 'upstream/feature/HEAD'
    )
    expect(nestedRef).toBeDefined()
    expect(git(tmpDir, ['rev-parse', '--verify', nestedRef ?? '']).trim()).toBe(sha)
    expect(results).not.toContain('upstream/HEAD')
  })

  it('preserves Git disambiguation prefixes for colliding local and remote refs', () => {
    const results = parseAndFilterSearchRefDetails(
      [
        'refs/heads/origin/main\0heads/origin/main',
        'refs/remotes/origin/main\0remotes/origin/main'
      ].join('\n'),
      10,
      ['origin']
    )

    expect(results).toEqual([
      { refName: 'refs/heads/origin/main', localBranchName: 'origin/main' },
      { refName: 'refs/remotes/origin/main', localBranchName: 'main' }
    ])
  })

  it('keeps a disambiguated local branch attached to its real branch name', () => {
    const branch = 'feature/colliding-tag'
    const results = parseAndFilterSearchRefDetails(`refs/heads/${branch}\0heads/${branch}`, 10)

    expect(results).toEqual([{ refName: `refs/heads/${branch}`, localBranchName: branch }])
  })

  it('tolerates trailing, leading, and doubled slashes in the query', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    // Why: empty tokens from stray slashes would degrade to `**` and match nothing, so they're filtered out.
    expect(await searchBaseRefs(tmpDir, 'upstream/')).toContain('upstream/main')
    expect(await searchBaseRefs(tmpDir, '/upstream')).toContain('upstream/main')
    expect(await searchBaseRefs(tmpDir, 'upstream//main')).toContain('upstream/main')
  })

  it('finds a remote branch when the query is the local branch name with slashes', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'origin/plan/unified-brainstorm-plan-docs', sha)

    const results = await searchBaseRefs(tmpDir, 'plan/unified-brainstorm-plan-docs')

    expect(results).toContain('origin/plan/unified-brainstorm-plan-docs')
  })

  it('finds a remote branch by local branch name when the remote name has slashes', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'foo/bar', 'https://example.invalid/repo.git'])
    createRemoteRef(tmpDir, 'foo/bar/plan/unified-brainstorm-plan-docs', sha)

    const results = await searchBaseRefs(tmpDir, 'plan/unified-brainstorm-plan-docs')

    expect(results).toContain('foo/bar/plan/unified-brainstorm-plan-docs')
  })

  it('does not match slash queries inside unrelated nested branch paths', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'upstream', 'https://example.invalid/upstream.git'])
    createRemoteRef(tmpDir, 'origin/upstream/feature-x', sha)
    createRemoteRef(tmpDir, 'origin/foo/upstream/feature-x', sha)
    createRemoteRef(tmpDir, 'upstream/feature-y', sha)

    const results = await searchBaseRefs(tmpDir, 'upstream/feat')

    expect(results).toContain('upstream/feature-y')
    expect(results).toContain('origin/upstream/feature-x')
    expect(results).not.toContain('origin/foo/upstream/feature-x')
  })

  it('keeps display-format matches when many branch-root matches share the query', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'upstream', 'https://example.invalid/upstream.git'])
    for (let i = 0; i < 12; i += 1) {
      createRemoteRef(tmpDir, `origin/upstream/feature-${i}`, sha)
    }
    createRemoteRef(tmpDir, 'upstream/feature-target', sha)

    const results = await searchBaseRefs(tmpDir, 'upstream/feature', 2)

    expect(results).toContain('upstream/feature-target')
  })

  it('still finds a local-branch-name match when the first segment is also a remote name', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'plan', 'https://example.invalid/plan.git'])
    createRemoteRef(tmpDir, 'origin/plan/docs', sha)

    const results = await searchBaseRefs(tmpDir, 'plan/docs')

    expect(results).toContain('origin/plan/docs')
  })

  it('keeps branch-root matches when many display-format matches share the query', async () => {
    const sha = getHeadSha(tmpDir)
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git'])
    git(tmpDir, ['remote', 'add', 'plan', 'https://example.invalid/plan.git'])
    for (let i = 0; i < 12; i += 1) {
      createRemoteRef(tmpDir, `plan/docs-${i}`, sha)
    }
    createRemoteRef(tmpDir, 'origin/plan/docs', sha)

    const results = await searchBaseRefs(tmpDir, 'plan/docs', 2)

    expect(results).toContain('origin/plan/docs')
  })

  it('finds a local slashed branch when the query repeats the full branch name', async () => {
    git(tmpDir, ['branch', 'plan/unified-brainstorm-plan-docs'])

    const results = await searchBaseRefs(tmpDir, 'plan/unified-brainstorm-plan-docs')

    expect(results).toContain('refs/heads/plan/unified-brainstorm-plan-docs')
  })
})

describe('getBaseRefDefault (regression — unchanged behavior)', async () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-test-'))
    initRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns origin/main when both origin/main and upstream/main exist (origin wins)', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const result = await getBaseRefDefault(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('returns the target of origin/HEAD when set', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = await getBaseRefDefault(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('falls through from a stale origin/HEAD target to an existing primary ref', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'])

    const result = await getBaseRefDefault(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('falls through from a stale origin/HEAD primary target to another existing default ref', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/master', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = await getBaseRefDefault(tmpDir)

    expect(result).toBe('origin/master')
  })

  it('resolves symbolic chains to a default branch outside the primary candidates', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/release/stable', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/alias', 'refs/remotes/origin/release/stable'])
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/alias'])

    await expect(getBaseRefDefault(tmpDir)).resolves.toBe('origin/release/stable')
  })

  it('ignores descendants of primary candidates', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main/topic', sha)
    createRemoteRef(tmpDir, 'origin/master', sha)

    await expect(getBaseRefDefault(tmpDir)).resolves.toBe('origin/master')
  })

  it('does NOT fall through to upstream/main when origin/* is absent', async () => {
    // Why: default probe order is origin-only by design; upstream-aware defaulting is deferred.
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const result = await getBaseRefDefault(tmpDir)

    // initRepo creates a local `main`, so with no origin/* we expect it — not `upstream/main`.
    expect(result).toBe('main')
    expect(result).not.toBe('upstream/main')
  })
})

describe('resolveDefaultBaseRefViaExec', () => {
  it('resolves the primary fallback ordering with one exact ref query', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      return {
        stdout: 'refs/heads/main\0\nrefs/remotes/origin/master\0\nrefs/remotes/origin/main\0\n'
      }
    }

    await expect(resolveDefaultBaseRefViaExec(exec)).resolves.toBe('origin/main')
    expect(calls).toEqual([
      [
        'for-each-ref',
        '--format=%(refname)%00%(symref)',
        'refs/remotes/origin/HEA[D]',
        'refs/remotes/origin/mai[n]',
        'refs/remotes/origin/maste[r]',
        'refs/heads/mai[n]',
        'refs/heads/maste[r]'
      ]
    ])
  })

  it('returns null if the host cannot read the ref table', async () => {
    await expect(
      resolveDefaultBaseRefViaExec(async () => {
        throw new Error('unavailable host')
      })
    ).resolves.toBeNull()
  })
})

describe('getRemoteCount', async () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-test-'))
    initRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 0 for a repo with no remotes', async () => {
    const count = await getRemoteCount(tmpDir)
    expect(count).toBe(0)
  })

  it('returns 1 for a repo with origin only', async () => {
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.com/repo.git'])

    const count = await getRemoteCount(tmpDir)

    expect(count).toBe(1)
  })

  it('returns 2 for a repo with origin + upstream', async () => {
    git(tmpDir, ['remote', 'add', 'origin', 'https://example.com/fork.git'])
    git(tmpDir, ['remote', 'add', 'upstream', 'https://example.com/source.git'])

    const count = await getRemoteCount(tmpDir)

    expect(count).toBe(2)
  })

  it('returns 0 on error (non-existent path)', async () => {
    const count = await getRemoteCount(path.join(tmpDir, 'does-not-exist'))

    expect(count).toBe(0)
  })
})
