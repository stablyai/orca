import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildSearchBaseRefsArgv,
  getDefaultBaseRef,
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
  git(dir, ['config', 'user.email', 'test@test.com'])
  git(dir, ['config', 'user.name', 'Test'])
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

    expect(results).toContain('feature/login')
  })

  it('finds a local slashed branch when the query lands in an ancestor segment', async () => {
    git(tmpDir, ['branch', 'feature/login'])

    const results = await searchBaseRefs(tmpDir, 'feature')

    expect(results).toContain('feature/login')
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
      refName: 'feature/something',
      localBranchName: 'feature/something'
    })
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

    expect(results).toContain('upstream/feature/HEAD')
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

    expect(results.map((result) => result.refName)).toEqual([
      'heads/origin/main',
      'remotes/origin/main'
    ])
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

    expect(results).toContain('plan/unified-brainstorm-plan-docs')
  })
})

describe('getDefaultBaseRef (regression — unchanged behavior)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-test-'))
    initRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns origin/main when both origin/main and upstream/main exist (origin wins)', () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const result = getDefaultBaseRef(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('returns the target of origin/HEAD when set', () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = getDefaultBaseRef(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('falls through from a stale origin/HEAD target to an existing primary ref', () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'])

    const result = getDefaultBaseRef(tmpDir)

    expect(result).toBe('origin/main')
  })

  it('falls through from a stale origin/HEAD primary target to another existing default ref', () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'origin/master', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = getDefaultBaseRef(tmpDir)

    expect(result).toBe('origin/master')
  })

  it('does NOT fall through to upstream/main when origin/* is absent', () => {
    // Why: default probe order is origin-only by design; upstream-aware defaulting is deferred.
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const result = getDefaultBaseRef(tmpDir)

    // initRepo creates a local `main`, so with no origin/* we expect it — not `upstream/main`.
    expect(result).toBe('main')
    expect(result).not.toBe('upstream/main')
  })
})

describe('resolveDefaultBaseRefViaExec', () => {
  it('falls through from a stale origin/HEAD target to the probe list', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/master\n' }
      }
      if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main') {
        return { stdout: 'main-sha\n' }
      }
      throw new Error('missing ref')
    }

    await expect(resolveDefaultBaseRefViaExec(exec)).resolves.toBe('origin/main')

    expect(calls).toEqual([
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']
    ])
  })

  it('verifies origin/HEAD even when it points at origin/main', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n' }
      }
      if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/master') {
        return { stdout: 'master-sha\n' }
      }
      throw new Error('missing ref')
    }

    await expect(resolveDefaultBaseRefViaExec(exec)).resolves.toBe('origin/master')

    expect(calls).toEqual([
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']
    ])
  })
})

describe('getRemoteCount', () => {
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
