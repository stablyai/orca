import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { getDefaultBaseRef, getRemoteCount, searchBaseRefs } from './repo'

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

  it('returns [] for a repo with no matching refs', async () => {
    const results = await searchBaseRefs(tmpDir, 'nonexistent-query-xyz')

    expect(results).toEqual([])
  })

  it('returns [] without error for an empty query', async () => {
    const results = await searchBaseRefs(tmpDir, '')

    expect(results).toEqual([])
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
