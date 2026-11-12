import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count subprocesses: unchanged OIDs reuse summaries and base fetches share a throttle window.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const scratchFolderPrefixes = vi.hoisted((): string[] => [])

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
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

import { findGitSubcommandIndex } from '../../../../shared/git/commands/git-command-classification'

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
    return handler(argv).then((result) => ({ ...result, executionContext: { kind: 'host' } }))
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

  it('stops waiting on a hung base fetch after 10 s and uses the local tracking ref', async () => {
    mockGitDispatch({ fetch: () => new Promise<GitResult>(() => {}) })

    const summary = deriveSummary()
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(1))
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(summary).resolves.toEqual(expectedSummary)
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
