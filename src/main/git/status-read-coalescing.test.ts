import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import type * as NodeFs from 'node:fs'
import path from 'node:path'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { clearEffectiveUpstreamStatusCacheForTests, getStatus, stageFile } from './status'

describe('getStatus', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    gitStreamOptionsMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    // Why: after the status call, getStatus may issue `git diff --numstat`
    // calls to attach per-entry line counts. Tests that don't care about counts
    // set only a `mockResolvedValueOnce` for the status output; this default
    // keeps those follow-up numstat calls from returning undefined.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it('opts status reads into direct WSL Git without changing mutation options', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)

    await getStatus('/repo', { wslDistro: 'Ubuntu' })
    await stageFile('/repo', 'src/file.ts', { wslDistro: 'Ubuntu' })

    expect(gitStreamOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferWslDirectGit: true, wslDistro: 'Ubuntu' })
    )
    const addOptions = gitExecFileAsyncMock.mock.calls.find(([args]) =>
      (args as string[]).includes('add')
    )?.[1] as { preferWslDirectGit?: boolean } | undefined
    expect(addOptions).toBeDefined()
    expect(addOptions?.preferWslDirectGit).toBeUndefined()
  })

  it('benchmarks concurrent status burst subprocess pressure', async () => {
    const benchPath = process.env.ORCA_GIT_STATUS_COALESCING_BENCH_JSON
    if (!benchPath) {
      return
    }

    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const runBurst = async (withSignals: boolean): Promise<number> => {
      gitExecFileAsyncMock.mockClear()
      await Promise.all(
        Array.from({ length: 10 }, () =>
          getStatus('/repo', withSignals ? { signal: new AbortController().signal } : {})
        )
      )
      return gitExecFileAsyncMock.mock.calls.filter(([args]) =>
        (args as string[]).includes('status')
      ).length
    }

    const startedAt = performance.now()
    const unsignalledStatusCommandCalls = await runBurst(false)
    const signalledStatusCommandCalls = await runBurst(true)
    const durationMs = performance.now() - startedAt
    const { mkdirSync, writeFileSync } = await vi.importActual<typeof NodeFs>('fs')
    mkdirSync(path.dirname(benchPath), { recursive: true })
    writeFileSync(
      benchPath,
      JSON.stringify({
        scenario: 'git-status-concurrent-burst',
        concurrentCalls: 10,
        unsignalledStatusCommandCalls,
        signalledStatusCommandCalls,
        statusArgs: [
          '-c',
          'core.quotePath=false',
          'status',
          '--porcelain=v2',
          '--branch',
          '--untracked-files=all'
        ],
        durationMs
      })
    )
  })

  it('coalesces identical in-flight status reads without caching after settle', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    const releaseStatusReads: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatusReads.push(() => resolve({ stdout: '' }))
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const sharedRead = Promise.all([getStatus('/repo'), getStatus('/repo'), getStatus('/repo')])
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    releaseStatusReads.splice(0).forEach((release) => release())
    await sharedRead
    expect(statusCommandCalls).toBe(1)

    const settledRead = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(2))
    releaseStatusReads.splice(0).forEach((release) => release())
    await settledRead
    expect(statusCommandCalls).toBe(2)
  })

  it('shares one physical status read across distinct caller signals', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let releaseStatus!: () => void
    let statusCommandCalls = 0
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatus = () => resolve({ stdout: '' })
        })
      }
      return Promise.resolve({ stdout: '' })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstError = new Error('first caller cancelled')
    const first = getStatus('/repo', { signal: firstController.signal })
    const second = getStatus('/repo', { signal: secondController.signal })

    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const underlyingSignal = gitStreamOptionsMock.mock.calls[0]?.[0].signal as AbortSignal
    firstController.abort(firstError)
    await expect(first).rejects.toBe(firstError)
    expect(underlyingSignal?.aborted).toBe(false)

    releaseStatus()
    await expect(second).resolves.toMatchObject({ entries: [] })
    expect(statusCommandCalls).toBe(1)
  })

  it('aborts physical status work after its last live caller cancels', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    let rejectStatus!: (error: unknown) => void
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (!args.includes('status')) {
        return Promise.resolve({ stdout: '' })
      }
      statusCommandCalls += 1
      if (statusCommandCalls > 1) {
        return Promise.resolve({ stdout: '' })
      }
      return new Promise<{ stdout: string }>((_resolve, reject) => {
        rejectStatus = reject
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = getStatus('/repo', { signal: firstController.signal })
    const second = getStatus('/repo', { signal: secondController.signal })

    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const underlyingSignal = gitStreamOptionsMock.mock.calls[0]?.[0].signal as AbortSignal
    underlyingSignal.addEventListener('abort', () => rejectStatus(underlyingSignal.reason), {
      once: true
    })
    firstController.abort(new Error('first cancelled'))
    await expect(first).rejects.toThrow('first cancelled')
    expect(underlyingSignal.aborted).toBe(false)
    secondController.abort(new Error('second cancelled'))
    await expect(second).rejects.toThrow('second cancelled')
    expect(underlyingSignal.aborted).toBe(true)

    await expect(getStatus('/repo')).resolves.toMatchObject({ entries: [] })
    expect(statusCommandCalls).toBe(2)
  })

  it('rejects a pre-aborted caller without starting or joining status work', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let releaseStatus!: () => void
    let statusCommandCalls = 0
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatus = () => resolve({ stdout: '' })
        })
      }
      return Promise.resolve({ stdout: '' })
    })
    const active = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const controller = new AbortController()
    const abortError = new Error('already cancelled')
    controller.abort(abortError)

    await expect(getStatus('/repo', { signal: controller.signal })).rejects.toBe(abortError)
    expect(statusCommandCalls).toBe(1)

    releaseStatus()
    await active
  })

  it('isolates status reads by worktree, host, and output-affecting options', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    const releases: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releases.push(() => resolve({ stdout: '' }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })
    const reads = [
      getStatus('/repo'),
      getStatus('/other-repo'),
      getStatus('/repo', { wslDistro: 'Ubuntu' }),
      getStatus('/repo', { includeIgnored: true }),
      getStatus('/repo', { reuseLineStats: true }),
      getStatus('/repo', { bypassEffectiveUpstreamNegativeCache: true }),
      getStatus('/repo', { limit: 1 }),
      getStatus('/repo', { sharedLinkPaths: ['node_modules'] })
    ]

    await vi.waitFor(() => expect(statusCommandCalls).toBe(8))
    releases.splice(0).forEach((release) => release())
    await Promise.all(reads)
    expect(statusCommandCalls).toBe(8)
  })

  it('clears in-flight status reads when a mutation runs', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    const releaseStatusReads: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatusReads.push(() => resolve({ stdout: '' }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const first = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))

    // A mutation must invalidate the in-flight status read so the next getStatus
    // starts fresh instead of joining a pre-mutation promise and going stale.
    await stageFile('/repo', 'src/file.ts')

    const second = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(2))

    releaseStatusReads.splice(0).forEach((release) => release())
    await Promise.all([first, second])
    expect(statusCommandCalls).toBe(2)
  })

  it('fences reads started before, during, and after a concurrent mutation', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    let releaseMutation!: () => void
    const releaseStatusReads: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatusReads.push(() => resolve({ stdout: '' }))
        })
      }
      if (args.includes('add')) {
        return new Promise<{ stdout: string }>((resolve) => {
          releaseMutation = () => resolve({ stdout: '' })
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const beforeMutation = getStatus('/repo', { signal: new AbortController().signal })
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const mutation = stageFile('/repo', 'src/file.ts')
    const duringMutation = getStatus('/repo', { signal: new AbortController().signal })
    await vi.waitFor(() => expect(statusCommandCalls).toBe(2))
    releaseMutation()
    await mutation
    const afterMutation = getStatus('/repo', { signal: new AbortController().signal })
    await vi.waitFor(() => expect(statusCommandCalls).toBe(3))

    releaseStatusReads.splice(0).forEach((release) => release())
    await Promise.all([beforeMutation, duringMutation, afterMutation])
    expect(statusCommandCalls).toBe(3)
  })
})
