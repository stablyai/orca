import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as GitRunner from './runner'
import type { GitExec } from '../../relay/git-handler-ops'
import type { RelayGitStreamExec } from '../../relay/git-stdout-stream'

const { gitStreamStdoutMock, readFileMock } = vi.hoisted(() => ({
  gitStreamStdoutMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, readFile: readFileMock }
})

vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitStreamStdout: gitStreamStdoutMock }
})

import { getStatus } from './status'
import { getStatusOp } from '../../relay/git-handler-status-ops'

const BENCH_DELAY_MS = 25
const BENCH_SAMPLES = 31
const BENCH_WARMUPS = 5
const describeBench = process.env.ORCA_GIT_STATUS_OVERLAP_BENCH === '1' ? describe : describe.skip

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

type BenchmarkResult = {
  path: string
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]!
}

describe('git status conflict-read overlap', () => {
  const relayGit: GitExec = async () => ({ stdout: '', stderr: '' })

  beforeEach(() => {
    readFileMock.mockReset()
    gitStreamStdoutMock.mockReset()
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitStreamStdoutMock.mockResolvedValue({ stoppedEarly: false })
  })

  it('starts native status before conflict-marker I/O settles', async () => {
    const markerRead = deferred<string>()
    const statusStarted = deferred<void>()
    readFileMock.mockReturnValue(markerRead.promise)
    gitStreamStdoutMock.mockImplementation(async () => {
      statusStarted.resolve()
      return { stoppedEarly: false }
    })

    const resultPromise = getStatus('/repo')
    await statusStarted.promise
    expect(readFileMock).toHaveBeenCalledWith(join('/repo', '.git'), 'utf-8')

    markerRead.resolve('gitdir: /repo/.git/worktrees/feature\n')
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('starts relay status before conflict-marker I/O settles', async () => {
    const markerRead = deferred<string>()
    const statusStarted = deferred<void>()
    readFileMock.mockReturnValue(markerRead.promise)
    const relayStreamGit: RelayGitStreamExec = async () => {
      statusStarted.resolve()
      return { stoppedEarly: false }
    }

    const resultPromise = getStatusOp(relayGit, relayStreamGit, { worktreePath: '/repo' })
    await statusStarted.promise
    expect(readFileMock).toHaveBeenCalledWith(join('/repo', '.git'), 'utf-8')

    markerRead.resolve('gitdir: /repo/.git/worktrees/feature\n')
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('observes an early native status rejection while marker I/O remains pending', async () => {
    const markerRead = deferred<string>()
    readFileMock.mockReturnValue(markerRead.promise)
    gitStreamStdoutMock.mockRejectedValue(new Error('status failed first'))
    let settled = false

    const resultPromise = getStatus('/repo').finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    markerRead.resolve('gitdir: /repo/.git/worktrees/feature\n')
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('keeps a synchronous native status failure fail-soft', async () => {
    const statusError = new Error('status threw')
    gitStreamStdoutMock.mockImplementation(() => {
      throw statusError
    })

    await expect(getStatus('/repo')).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it.each(['throw', 'reject'] as const)('keeps relay %s failures fail-soft', async (mode) => {
    const statusError = new Error(`status ${mode}`)
    const relayStreamGit = (() => {
      if (mode === 'throw') {
        throw statusError
      }
      return Promise.reject(statusError)
    }) as RelayGitStreamExec

    await expect(
      getStatusOp(relayGit, relayStreamGit, { worktreePath: '/repo' })
    ).resolves.toMatchObject({ entries: [], conflictOperation: 'unknown' })
  })

  it('rethrows the original relay status failure after cancellation', async () => {
    const controller = new AbortController()
    const statusError = new Error('cancelled status')
    const relayStreamGit: RelayGitStreamExec = async () => {
      controller.abort(statusError)
      throw statusError
    }

    await expect(
      getStatusOp(
        relayGit,
        relayStreamGit,
        { worktreePath: '/repo' },
        { signal: controller.signal }
      )
    ).rejects.toBe(statusError)
  })

  it('surfaces detector errors without waiting for a hung status read', async () => {
    const statusStarted = deferred<void>()
    const relayStreamGit: RelayGitStreamExec = () => {
      statusStarted.resolve()
      return new Promise(() => {})
    }
    const invalidPath = { toString: () => '/repo' }

    const resultPromise = getStatusOp(relayGit, relayStreamGit, {
      worktreePath: invalidPath
    })
    const rejection = expect(resultPromise).rejects.toThrow(TypeError)
    await statusStarted.promise
    await rejection
  })

  it('keeps detector errors ahead of concurrent status failures', async () => {
    const statusError = new Error('status failed too')
    const relayStreamGit = (() => {
      throw statusError
    }) as RelayGitStreamExec
    const invalidPath = { toString: () => '/repo' }

    const result = getStatusOp(relayGit, relayStreamGit, { worktreePath: invalidPath })
    await expect(result).rejects.toBeInstanceOf(TypeError)
  })
})

describeBench('git status conflict-read overlap benchmark', () => {
  it('measures native and relay orchestration with matched independent latency', async () => {
    readFileMock.mockImplementation(async () => {
      await wait(BENCH_DELAY_MS)
      return 'gitdir: /repo/.git/worktrees/feature\n'
    })
    gitStreamStdoutMock.mockImplementation(async () => {
      await wait(BENCH_DELAY_MS)
      return { stoppedEarly: false }
    })
    const relayGit: GitExec = async () => ({ stdout: '', stderr: '' })
    const relayStreamGit: RelayGitStreamExec = async () => {
      await wait(BENCH_DELAY_MS)
      return { stoppedEarly: false }
    }
    const cases = [
      { name: 'native', run: () => getStatus('/repo') },
      {
        name: 'relay',
        run: () => getStatusOp(relayGit, relayStreamGit, { worktreePath: '/repo' })
      }
    ]

    const results: BenchmarkResult[] = []
    for (const benchmarkCase of cases) {
      for (let index = 0; index < BENCH_WARMUPS; index += 1) {
        await benchmarkCase.run()
      }
      const samples: number[] = []
      for (let index = 0; index < BENCH_SAMPLES; index += 1) {
        const startedAt = performance.now()
        await benchmarkCase.run()
        samples.push(performance.now() - startedAt)
      }
      results.push({
        path: benchmarkCase.name,
        medianMs: Number(percentile(samples, 0.5).toFixed(3)),
        p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
        minMs: Number(Math.min(...samples).toFixed(3)),
        maxMs: Number(Math.max(...samples).toFixed(3))
      })
    }

    console.table(results)
    expect(results).toHaveLength(2)
  }, 10_000)
})
