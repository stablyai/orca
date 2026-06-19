import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import {
  buildSearchBaseRefsArgv,
  getDefaultBaseRef,
  getBranchConflictKind,
  getRemoteCount,
  parseAndFilterSearchRefDetails,
  searchBaseRefDetails,
  searchBaseRefs
} from './repo'

// Why: these tests exercise real git state (not mocked gitExecFileAsync)
// because the change under test is in the `for-each-ref` glob argument
// shape — the exact kind of bug a mock-based test would miss.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet'])
  // Why: explicit symbolic-ref rather than `git init --initial-branch=main`
  // (which requires git >= 2.28). Setting HEAD before the first commit
  // makes the initial branch `main` regardless of host git version or
  // `init.defaultBranch` config.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.email', 'test@test.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['commit', '--allow-empty', '-m', 'initial', '--quiet'])
}

/**
 * Create a remote-tracking ref in `mainDir` at the given short-name
 * (e.g. `origin/main`) by creating a packed ref under refs/remotes.
 * Uses `update-ref` so we don't need to actually configure a live remote.
 */
function createRemoteRef(mainDir: string, shortName: string, sha: string): void {
  git(mainDir, ['update-ref', `refs/remotes/${shortName}`, sha])
}

function getHeadSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

describe('buildSearchBaseRefsArgv', () => {
  it('caps broad local ref searches before parsing results', () => {
    const argv = buildSearchBaseRefsArgv('feature', 25)

    expect(argv).toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/*feature*')
    expect(argv).toContain('refs/remotes/**/*feature*/**')
  })

  it('keeps segmented display-format searches bounded', () => {
    const argv = buildSearchBaseRefsArgv('upstream/main', 10)

    expect(argv).toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=40')
    expect(argv).toContain('refs/remotes/*upstream*/*main*')
    expect(argv).toContain('refs/heads/*upstream*/*main*')
    expect(argv).toContain('refs/remotes/*/upstream/main*')
    expect(argv).toContain('refs/heads/upstream/main*')
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
    // symbolic-ref creates the HEAD pseudo-ref
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

  // Why: a single-word query must match a term in ANY segment of a slashed
  // branch name (`user/feature`), not just the leaf. fnmatch `*` does not
  // cross `/`, so the glob must use `**` to span ref segments.
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
    createRemoteRef(tmpDir, 'origin/feature/something', sha)
    createRemoteRef(tmpDir, 'upstream/feature/something', sha)

    expect(
      await getBranchConflictKind(tmpDir, 'feature/something', 'origin/feature/something')
    ).toBe('remote')
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

    expect(argv).toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=48')
  })

  it('does not hard-cap large explicit ref-search limits below the request size', () => {
    const argv = buildSearchBaseRefsArgv('', 600)

    expect(argv).toContain('--count=2400')
  })

  it('returns [] for invalid search limits instead of running an uncapped search', async () => {
    await expect(searchBaseRefs(tmpDir, '', 0.5)).resolves.toEqual([])
    await expect(searchBaseRefs(tmpDir, '', Number.NaN)).resolves.toEqual([])
  })

  // Why: the picker displays results as `<remote>/<branch>` and labels
  // `origin/main` as "Current", so users naturally retype the displayed
  // format. Before segment-wise globbing this returned [] because the
  // slash in the query made every fnmatch pattern unable to match.
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
    // Why: `upstream/feat` pins the remote segment to *upstream*, so
    // origin/feature-x must not leak in.
    expect(results).not.toContain('origin/feature-x')
  })

  it('does not match when tokens are in the wrong segments', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    // Why: `main/upstream` means "remote matching *main*, branch matching
    // *upstream*". upstream/main has remote=upstream (no `main`) and
    // branch=main (no `upstream`), so it must NOT match — confirms each
    // token is pinned to its own segment, not treated as a free substring.
    const results = await searchBaseRefs(tmpDir, 'main/upstream')

    expect(results).not.toContain('upstream/main')
  })

  it('still filters HEAD pseudo-refs for display-format queries', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)
    git(tmpDir, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main'])

    // Why: typing `upstream/HEAD` must not surface the pseudo-ref even
    // though it's a valid display-format query — the HEAD filter runs
    // after the glob match, so coverage of the filter must survive
    // changes to the glob shape.
    const results = await searchBaseRefs(tmpDir, 'upstream/HEAD')

    expect(results).not.toContain('upstream/HEAD')
  })

  it('tolerates trailing, leading, and doubled slashes in the query', async () => {
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    // Why: empty tokens from trailing/leading/doubled slashes would
    // degrade to `**` segments with fnmatch, matching nothing useful
    // and silently breaking the feature. Filtering empty tokens keeps
    // the query behavior identical to the intended non-empty tokens.
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

  it('does NOT fall through to upstream/main when origin/* is absent', () => {
    // Why: this is the explicit design decision — the default probe order
    // is origin-only. upstream-aware defaulting is deferred work.
    const sha = getHeadSha(tmpDir)
    createRemoteRef(tmpDir, 'upstream/main', sha)

    const result = getDefaultBaseRef(tmpDir)

    // With no origin/* but a local main branch (initRepo creates one),
    // we expect the local `main` — NOT `upstream/main`.
    expect(result).toBe('main')
    expect(result).not.toBe('upstream/main')
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
