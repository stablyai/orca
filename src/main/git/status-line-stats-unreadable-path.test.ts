import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../shared/git-status-types'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => env,
  gitStreamStdout: vi.fn()
}))

import { attachLineStats } from './source-control/status-line-stats'
import { GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS } from '../../shared/git-status-line-stats-cache'

const LOCKED = 'data/app state.json'

function unstaged(entryPath: string): GitStatusEntry {
  return { path: entryPath, area: 'unstaged', status: 'modified' }
}

function cannotHash(entryPath: string): Error {
  return Object.assign(new Error('Command failed: git diff'), {
    stdout: '',
    stderr: `error: open("${entryPath}"): Permission denied\nfatal: cannot hash ${entryPath}\n`
  })
}

function excludedPaths(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith(':(top,exclude,literal)'))
}

describe('unreadable path exclusions across polls', () => {
  let worktreeCount = 0
  let WORKTREE: string

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    // Exclusions are remembered per worktree, so each test gets a fresh one.
    WORKTREE = `/repo-${worktreeCount++}`
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops retrying when Git reports a path it already excluded', async () => {
    gitExecFileAsyncMock.mockRejectedValue(cannotHash(LOCKED))
    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]

    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0].added).toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('remembers capped exclusions until the original TTL expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let next = 0
    gitExecFileAsyncMock.mockImplementation(async () => {
      throw cannotHash(`locked-${next++}.db`)
    })
    const entries = [unstaged('src/a.ts'), unstaged('locked-0.db')]

    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0].added).toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(9)
    gitExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockRejectedValue(cannotHash('locked-8.db'))
    vi.advanceTimersByTime(GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS - 1)

    expect(await attachLineStats(WORKTREE, entries)).toBe(false)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual(
      Array.from({ length: 8 }, (_, index) => `:(top,exclude,literal)locked-${index}.db`)
    )
    gitExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: '3\t1\tsrc/a.ts\u00002\t0\tlocked-0.db\u0000',
      stderr: ''
    })
    vi.advanceTimersByTime(1)

    expect(await attachLineStats(WORKTREE, entries)).toBe(true)
    expect(entries[0]).toMatchObject({ added: 3, removed: 1 })
    expect(entries[1]).toMatchObject({ added: 2, removed: 0 })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([])
  })

  it.each([
    {
      name: 'an unrelated Git error',
      error: Object.assign(new Error('Command failed'), { stderr: 'fatal: bad object HEAD\n' })
    },
    { name: 'an already excluded path', error: cannotHash('locked-0.db') }
  ])('does not remember exclusions when $name stops a pass at the cap', async ({ error }) => {
    for (let index = 0; index < 8; index++) {
      gitExecFileAsyncMock.mockRejectedValueOnce(cannotHash(`locked-${index}.db`))
    }
    gitExecFileAsyncMock.mockRejectedValueOnce(error)
    const entries = [unstaged('locked-0.db')]

    expect(await attachLineStats(WORKTREE, entries)).toBe(false)
    expect(entries[0].added).toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(9)
    gitExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '2\t0\tlocked-0.db\0', stderr: '' })

    expect(await attachLineStats(WORKTREE, entries)).toBe(true)
    expect(entries[0]).toMatchObject({ added: 2, removed: 0 })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([])
  })

  it('does not retry other numstat failures', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('Command failed'), { stderr: 'fatal: bad object HEAD\n' })
    )

    const complete = await attachLineStats(WORKTREE, [unstaged('src/a.ts')])

    expect(complete).toBe(false)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('starts the next poll with the remembered exclusion while the file stays locked', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValue({ stdout: '3\t1\tsrc/a.ts\0', stderr: '' })
    await attachLineStats(WORKTREE, [unstaged('src/a.ts'), unstaged(LOCKED)])
    gitExecFileAsyncMock.mockClear()

    const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]
    const complete = await attachLineStats(WORKTREE, entries)

    expect(complete).toBe(false)
    expect(entries[0]).toMatchObject({ added: 3, removed: 1 })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([
      `:(top,exclude,literal)${LOCKED}`
    ])
  })

  it.each([-3_600_000, 3_600_000])(
    'keeps the exclusion TTL after a wall-clock step of %i ms',
    async (wallClockStep) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      gitExecFileAsyncMock
        .mockRejectedValueOnce(cannotHash(LOCKED))
        .mockResolvedValue({ stdout: '3\t1\tsrc/a.ts\0', stderr: '' })
      await attachLineStats(WORKTREE, [unstaged('src/a.ts'), unstaged(LOCKED)])
      gitExecFileAsyncMock.mockClear()
      vi.setSystemTime(wallClockStep)

      const entries = [unstaged('src/a.ts'), unstaged(LOCKED)]
      expect(await attachLineStats(WORKTREE, entries)).toBe(false)
      expect(entries[0]).toMatchObject({ added: 3, removed: 1 })
      expect(entries[1].added).toBeUndefined()
      expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([
        `:(top,exclude,literal)${LOCKED}`
      ])
      gitExecFileAsyncMock.mockClear()
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: `3\t1\tsrc/a.ts\u00002\t0\t${LOCKED}\u0000`,
        stderr: ''
      })
      vi.advanceTimersByTime(GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS)

      expect(await attachLineStats(WORKTREE, entries)).toBe(true)
      expect(entries[1]).toMatchObject({ added: 2, removed: 0 })
      expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([])
    }
  )

  it('keeps remembered paths per worktree', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(cannotHash(LOCKED))
      .mockResolvedValue({ stdout: '', stderr: '' })
    await attachLineStats(WORKTREE, [unstaged(LOCKED)])
    gitExecFileAsyncMock.mockClear()

    await attachLineStats('/other', [unstaged('src/a.ts')])

    expect(excludedPaths(gitExecFileAsyncMock.mock.calls[0][0])).toEqual([])
  })
})
