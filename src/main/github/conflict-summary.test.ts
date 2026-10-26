import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count subprocesses: unchanged OIDs reuse summaries and base fetches share a throttle window.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const scratchFolderPrefixes = vi.hoisted((): string[] => [])

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
// Why: off Windows a WSL objects path is relative, so a real scratch dir would land in the cwd.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      scratchFolderPrefixes.push(prefix)
      if (!isAbsolute(prefix)) {
        throw new Error('no object store in this test')
      }
      return actual.mkdtemp(prefix)
    }
  }
})

import { findGitSubcommandIndex } from '../../shared/git-command-classification'
import { GIT_CAPABILITY_RETRY_INTERVAL_MS } from '../../shared/git-capability-cache'
import { getLocalGitCapabilityCache } from '../git/git-capability-state'
import { CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS } from './conflict-summary-cache'
import { __resetPRConflictSummaryCachesForTests, getPRConflictSummary } from './conflict-summary'

type GitResult = { stdout: string }
type GitHandler = (argv: string[]) => Promise<GitResult>

const COMMON_DIR_COMMAND = 'rev-parse --git-common-dir'

const defaultHandlers: Record<string, GitHandler> = {
  fetch: async () => ({ stdout: '' }),
  'rev-parse': async () => ({ stdout: 'base-tip-1\n' }),
  'merge-base': async () => ({ stdout: 'merge-base-1\n' }),
  'rev-list': async () => ({ stdout: '3\n' }),
  'merge-tree': async () => ({ stdout: 'tree-oid\u0000src/conflict.ts\u0000' }),
  [COMMON_DIR_COMMAND]: async () => ({ stdout: '.git\n' })
}

function commandKey(argv: string[]): string {
  const subcommand = argv[findGitSubcommandIndex(argv)]
  return subcommand === 'rev-parse' && argv.includes('--git-common-dir')
    ? COMMON_DIR_COMMAND
    : subcommand
}

function mockGitDispatch(overrides: Record<string, GitHandler> = {}): void {
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => {
    const key = commandKey(argv)
    const handler = overrides[key] ?? defaultHandlers[key]
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
  return calls.filter(([argv]) => Array.isArray(argv) && commandKey(argv) === command).length
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
    scratchFolderPrefixes.length = 0
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

    const initialSpawns = spawnCount()
    const second = await deriveSummary()
    const third = await deriveSummary()
    expect(second).toEqual(expectedSummary)
    expect(third).toEqual(expectedSummary)
    expect(spawnCount()).toBe(initialSpawns)
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
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
    releaseFetch?.({ stdout: '' })
    const [first, second] = await Promise.all([firstCall, secondCall])

    expect(first).toEqual(expectedSummary)
    expect(second).toEqual(expectedSummary)
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
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
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
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
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
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
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

    // Failed fetches need the same throttle or offline polling repeatedly pays the timeout.
    const repeat = await deriveSummary()
    expect(repeat).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
  })

  it('stops waiting on a hung base fetch after 10 s and uses the local tracking ref', async () => {
    mockGitDispatch({ fetch: () => new Promise<GitResult>(() => {}) })

    const summary = deriveSummary()
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(summary).resolves.toEqual(expectedSummary)
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
        ([argv, options]) => commandKey(argv) === 'fetch' && options?.wslDistro === 'Ubuntu'
      )
    ).toHaveLength(1)
  })

  it('preserves background admission across the complete WSL derivation chain', async () => {
    mockGitDispatch()
    // Known support adds the quarantine's common-dir read to the chain.
    getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' }).rememberSupported('merge-tree-write-tree')

    await getPRConflictSummary('/repo-root', 'main', 'github-base-oid', 'head-oid-1', {
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })

    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          cwd: '/repo-root',
          wslDistro: 'Ubuntu',
          admissionTier: 'background'
        })
      )
    }
  })

  it('keeps identities distinct when paths or ref names contain a joiner character', async () => {
    mockGitDispatch()

    // Pipe joining would alias these distinct repo/ref segment boundaries.
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

    await expect(deriveSummary()).resolves.toBeUndefined()
    expect(spawnCount()).toBe(failureSpawns)

    vi.setSystemTime(1_750_000_000_000 + CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS + 1_000)
    mockGitDispatch()
    await expect(deriveSummary()).resolves.toEqual(expectedSummary)
    expect(spawnCount('merge-base')).toBe(2)
  })

  it('does not repeat merge-tree --write-tree after an old-Git rejection', async () => {
    mockGitDispatch({
      'merge-tree': () =>
        Promise.reject(
          Object.assign(new Error('unknown option'), {
            stdout: 'usage: git merge-tree <base-tree> <branch1> <branch2>'
          })
        )
    })

    await expect(deriveSummary('head-oid-1')).resolves.toBeUndefined()
    await expect(deriveSummary('head-oid-2')).resolves.toBeUndefined()

    expect(spawnCount('merge-base')).toBe(2)
    expect(spawnCount('merge-tree')).toBe(1)
  })

  it('makes no scratch folder for a Git that rejects merge-tree --write-tree, retries included', async () => {
    // Git 2.25's exact rejection of both argument shapes.
    const rejected = Object.assign(new Error('Command failed: git merge-tree --write-tree'), {
      code: 129,
      stdout: '',
      stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>\n'
    })
    mockGitDispatch({ 'merge-tree': () => Promise.reject(rejected) })

    await expect(deriveSummary('head-oid-1')).resolves.toBeUndefined()
    vi.setSystemTime(1_750_000_000_000 + GIT_CAPABILITY_RETRY_INTERVAL_MS + 1_000)
    await expect(deriveSummary('head-oid-2')).resolves.toBeUndefined()

    expect(spawnCount('merge-tree')).toBe(2)
    expect(scratchFolderPrefixes).toEqual([])
    expect(gitExecFileAsyncMock.mock.calls.filter(([, options]) => options?.env)).toEqual([])
  })

  it('runs the legacy merge-tree fallback against the scratch object store too', async () => {
    const commonDir = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'orca-conflict-summary-'))),
      '.git'
    )
    mkdirSync(join(commonDir, 'objects'), { recursive: true })
    try {
      mockGitDispatch({
        [COMMON_DIR_COMMAND]: async () => ({ stdout: `${commonDir}\n` }),
        'merge-tree': async (argv) => {
          if (argv.includes('--merge-base')) {
            throw Object.assign(new Error("error: unknown option `merge-base'"), { stderr: '' })
          }
          return { stdout: 'tree-oid\u0000src/conflict.ts\u0000' }
        }
      })

      await expect(deriveSummary('head-oid-1')).resolves.toEqual(expectedSummary)
      await expect(deriveSummary('head-oid-2')).resolves.toEqual(expectedSummary)

      const legacy = gitExecFileAsyncMock.mock.calls.filter(
        ([argv]) => argv[0] === 'merge-tree' && !argv.includes('--merge-base')
      )
      expect(legacy).toHaveLength(2)
      expect(legacy[0]?.[1]?.env).toBeUndefined()
      expect(legacy[1]?.[1]?.env).toMatchObject({
        GIT_OBJECT_DIRECTORY: expect.stringContaining(
          join(commonDir, 'objects', 'tmp_objdir-orca-merge-tree-')
        ),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, 'objects')
      })
      expect(spawnCount('merge-tree')).toBe(3)
      expect(readdirSync(join(commonDir, 'objects'))).toEqual([])
    } finally {
      rmSync(join(commonDir, '..'), { recursive: true, force: true })
    }
  })
})
