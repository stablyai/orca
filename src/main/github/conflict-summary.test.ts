import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why these tests exist: the conflict-summary derivation used to re-run a
// network `git fetch` plus a four-subprocess chain on every PR refresh tick
// (measured ~490 full derivations in 2.1h on one machine). They pin the
// regression contract by counting subprocess spawns: unchanged inputs must
// cost zero subprocesses, and the base fetch must run at most once per
// throttle window.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS } from './conflict-summary-cache'
import { __resetPRConflictSummaryCachesForTests, getPRConflictSummary } from './conflict-summary'

type GitResult = { stdout: string }
type GitHandler = (argv: string[]) => Promise<GitResult>

const defaultHandlers: Record<string, GitHandler> = {
  fetch: async () => ({ stdout: '' }),
  'rev-parse': async () => ({ stdout: 'base-tip-1\n' }),
  'merge-base': async () => ({ stdout: 'merge-base-1\n' }),
  'rev-list': async () => ({ stdout: '3\n' }),
  'merge-tree': async () => ({ stdout: 'tree-oid\u0000src/conflict.ts\u0000' })
}

function mockGitDispatch(overrides: Record<string, GitHandler> = {}): void {
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => {
    const handler = overrides[argv[0]] ?? defaultHandlers[argv[0]]
    if (!handler) {
      return Promise.reject(new Error(`unexpected git command: ${argv.join(' ')}`))
    }
    return handler(argv)
  })
}

function spawnCount(command?: string): number {
  const calls = gitExecFileAsyncMock.mock.calls
  if (!command) {
    return calls.length
  }
  return calls.filter(([argv]) => Array.isArray(argv) && argv[0] === command).length
}

const expectedSummary = {
  baseRef: 'main',
  baseCommit: 'base-ti',
  commitsBehind: 3,
  files: ['src/conflict.ts']
}

function deriveSummary(headRefOid = 'head-oid-1', wslDistro?: string) {
  return getPRConflictSummary(
    '/repo-root',
    'main',
    'github-base-oid',
    headRefOid,
    wslDistro ? { wslDistro } : {}
  )
}

describe('getPRConflictSummary caching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_750_000_000_000)
    gitExecFileAsyncMock.mockReset()
    __resetPRConflictSummaryCachesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs exactly one fetch and one derivation chain, then zero subprocesses on repeat calls', async () => {
    mockGitDispatch()

    const first = await deriveSummary()
    expect(first).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount()).toBe(5)

    const second = await deriveSummary()
    const third = await deriveSummary()
    expect(second).toEqual(expectedSummary)
    expect(third).toEqual(expectedSummary)
    expect(spawnCount()).toBe(5)
  })

  it('re-derives when headRefOid changes without re-fetching inside the throttle window', async () => {
    mockGitDispatch()

    await deriveSummary('head-oid-1')
    const afterPush = await deriveSummary('head-oid-2')

    expect(afterPush).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount('rev-parse')).toBe(1)
    expect(spawnCount('merge-base')).toBe(2)
    expect(spawnCount('rev-list')).toBe(2)
    expect(spawnCount('merge-tree')).toBe(2)
  })

  it('fetches again after the throttle window and skips derivation when the base tip is unchanged', async () => {
    mockGitDispatch()

    await deriveSummary()
    vi.setSystemTime(1_750_000_000_000 + CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS + 1_000)
    const afterExpiry = await deriveSummary()

    expect(afterExpiry).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(2)
    expect(spawnCount('rev-parse')).toBe(2)
    // Why: same (headRefOid, latestBaseOid) pair — the summary cache still hits.
    expect(spawnCount('merge-base')).toBe(1)
    expect(spawnCount('rev-list')).toBe(1)
    expect(spawnCount('merge-tree')).toBe(1)
  })

  it('re-derives after the throttle window when the base tip moved', async () => {
    mockGitDispatch()
    await deriveSummary()

    vi.setSystemTime(1_750_000_000_000 + CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS + 1_000)
    mockGitDispatch({
      'rev-parse': async () => ({ stdout: 'base-tip-2\n' }),
      'rev-list': async () => ({ stdout: '5\n' })
    })
    const afterBaseMove = await deriveSummary()

    expect(afterBaseMove).toEqual({ ...expectedSummary, baseCommit: 'base-ti', commitsBehind: 5 })
    expect(spawnCount('fetch')).toBe(2)
    expect(spawnCount('merge-base')).toBe(2)
    expect(spawnCount('rev-list')).toBe(2)
    expect(spawnCount('merge-tree')).toBe(2)
  })

  it('dedupes concurrent identical calls onto one in-flight subprocess chain', async () => {
    let releaseFetch: ((value: GitResult) => void) | undefined
    mockGitDispatch({
      fetch: () =>
        new Promise<GitResult>((resolve) => {
          releaseFetch = resolve
        })
    })

    const firstCall = deriveSummary()
    const secondCall = deriveSummary()
    releaseFetch?.({ stdout: '' })
    const [first, second] = await Promise.all([firstCall, secondCall])

    expect(first).toEqual(expectedSummary)
    expect(second).toEqual(expectedSummary)
    expect(spawnCount()).toBe(5)
  })

  it('dedupes overlapping derivations after resolving the same live base tip', async () => {
    let releaseFetch: ((value: GitResult) => void) | undefined
    mockGitDispatch({
      fetch: () =>
        new Promise<GitResult>((resolve) => {
          releaseFetch = resolve
        })
    })

    const backgroundRefresh = getPRConflictSummary(
      '/repo-root',
      'main',
      'older-github-base-oid',
      'head-oid-1',
      {}
    )
    const manualRefresh = getPRConflictSummary(
      '/repo-root',
      'main',
      'newer-github-base-oid',
      'head-oid-1',
      {}
    )
    releaseFetch?.({ stdout: '' })
    const [backgroundSummary, manualSummary] = await Promise.all([backgroundRefresh, manualRefresh])

    expect(backgroundSummary).toEqual(expectedSummary)
    expect(manualSummary).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount('rev-parse')).toBe(1)
    expect(spawnCount('merge-base')).toBe(1)
    expect(spawnCount('rev-list')).toBe(1)
    expect(spawnCount('merge-tree')).toBe(1)
  })

  it('shares one base fetch across concurrent PRs on the same base branch', async () => {
    let releaseFetch: ((value: GitResult) => void) | undefined
    mockGitDispatch({
      fetch: () =>
        new Promise<GitResult>((resolve) => {
          releaseFetch = resolve
        })
    })

    const prA = deriveSummary('head-oid-a')
    const prB = deriveSummary('head-oid-b')
    releaseFetch?.({ stdout: '' })
    const [summaryA, summaryB] = await Promise.all([prA, prB])

    expect(summaryA).toEqual(expectedSummary)
    expect(summaryB).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount('rev-parse')).toBe(1)
    expect(spawnCount('merge-base')).toBe(2)
  })

  it('keeps concurrent fallback base OIDs isolated per PR when the base ref is unavailable', async () => {
    let releaseFetch: ((value: GitResult) => void) | undefined
    mockGitDispatch({
      fetch: () =>
        new Promise<GitResult>((resolve) => {
          releaseFetch = resolve
        }),
      'rev-parse': () => Promise.reject(new Error('missing remote-tracking ref')),
      'rev-list': async (argv) => ({
        stdout: argv[2]?.includes('bbbb2222-base') ? '7\n' : '4\n'
      }),
      'merge-tree': async (argv) => ({
        stdout: argv.includes('bbbb2222-base')
          ? 'tree-oid\u0000src/b.ts\u0000'
          : 'tree-oid\u0000src/a.ts\u0000'
      })
    })

    const prA = getPRConflictSummary('/repo-root', 'main', 'aaaa1111-base', 'head-oid-a', {})
    const prB = getPRConflictSummary('/repo-root', 'main', 'bbbb2222-base', 'head-oid-b', {})
    releaseFetch?.({ stdout: '' })
    const [summaryA, summaryB] = await Promise.all([prA, prB])

    expect(summaryA).toEqual({
      baseRef: 'main',
      baseCommit: 'aaaa111',
      commitsBehind: 4,
      files: ['src/a.ts']
    })
    expect(summaryB).toEqual({
      baseRef: 'main',
      baseCommit: 'bbbb222',
      commitsBehind: 7,
      files: ['src/b.ts']
    })
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount('merge-base')).toBe(2)
  })

  it('falls back to the local remote-tracking ref when fetch fails', async () => {
    mockGitDispatch({
      fetch: () => Promise.reject(new Error('offline'))
    })

    const summary = await deriveSummary()

    expect(summary).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)

    // Why: a failed fetch attempt must also be throttled — offline machines
    // were the worst case, paying the 10s fetch timeout on every tick.
    const repeat = await deriveSummary()
    expect(repeat).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
    expect(spawnCount()).toBe(5)
  })

  it("falls back to GitHub's baseRefOid when fetch and remote-tracking refs are unavailable", async () => {
    mockGitDispatch({
      fetch: () => Promise.reject(new Error('offline')),
      'rev-parse': () => Promise.reject(new Error('unknown revision'))
    })

    const summary = await deriveSummary()

    expect(summary).toEqual({ ...expectedSummary, baseCommit: 'github-' })
    expect(
      gitExecFileAsyncMock.mock.calls.some(
        ([argv]) => argv[0] === 'merge-base' && argv.includes('github-base-oid')
      )
    ).toBe(true)
  })

  it('keeps WSL-distro derivations isolated from host derivations', async () => {
    mockGitDispatch()

    await deriveSummary()
    await deriveSummary('head-oid-1', 'Ubuntu')

    expect(spawnCount('fetch')).toBe(2)
    expect(
      gitExecFileAsyncMock.mock.calls.filter(
        ([argv, options]) =>
          argv[0] === 'fetch' && (options as { wslDistro?: string })?.wslDistro === 'Ubuntu'
      )
    ).toHaveLength(1)
  })

  it('keeps identities distinct when paths or ref names contain a joiner character', async () => {
    mockGitDispatch()

    // Why: these two calls alias under naive pipe-joined keys — the segment
    // boundary shifts between repoPath and baseRefName.
    await getPRConflictSummary('/repo|x', 'main', 'github-base-oid', 'head-oid-1', {})
    await getPRConflictSummary('/repo', 'x|main', 'github-base-oid', 'head-oid-1', {})

    expect(spawnCount('fetch')).toBe(2)
    expect(spawnCount('merge-base')).toBe(2)
  })

  it('caches failed derivations only until the throttle window expires', async () => {
    mockGitDispatch({
      'merge-base': () => Promise.reject(new Error('bad object'))
    })

    await expect(deriveSummary()).resolves.toBeUndefined()
    const failureSpawns = spawnCount()

    // Within the window the failure is negative-cached: zero subprocesses.
    await expect(deriveSummary()).resolves.toBeUndefined()
    expect(spawnCount()).toBe(failureSpawns)

    // After expiry the derivation retries (a fetch may have brought objects in).
    vi.setSystemTime(1_750_000_000_000 + CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS + 1_000)
    mockGitDispatch()
    await expect(deriveSummary()).resolves.toEqual(expectedSummary)
    expect(spawnCount('merge-base')).toBe(2)
  })
})
