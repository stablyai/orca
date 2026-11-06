import type * as RunnerModule from '../runner'
import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../command-runner/git-stream-stdout'
import type * as GitProcessEnvModule from '../command-runner/git-process-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../../shared/node-bounded-file-reader'
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

vi.mock('../runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('../command-runner/git-exec-file', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitExecFileModule>()),
    gitExecFileAsync: runnerMocks.gitExecFileAsync,
    gitExecFileAsyncBuffer: runnerMocks.gitExecFileAsyncBuffer
  }
})

vi.mock('../command-runner/git-stream-stdout', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitStreamStdoutModule>()),
    gitStreamStdout: runnerMocks.gitStreamStdout
  }
})

vi.mock('../command-runner/git-process-env', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitProcessEnvModule>()),
    gitOptionalLocksDisabledEnv: runnerMocks.gitOptionalLocksDisabledEnv
  }
})

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { getBranchCompare } from './branch-compare'

describe('getBranchCompare', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
  })

  // Route by argv so independent concurrent reads can reorder safely.
  type BranchCompareGitResponses = {
    branch?: string | Error
    probe?: Record<string, string | Error>
    headOid?: string | Error
    baseOid?: string | Error
    mergeBase?: string | Error
    onMergeBase?: () => void
    nameStatus?: string | Error
    numstat?: string | Error
    revList?: string | Error
  }

  function mockBranchCompareGit(responses: BranchCompareGitResponses): void {
    const reply = (
      value: string | Error | undefined,
      label: string
    ): Promise<{ stdout: string }> => {
      if (value === undefined) {
        throw new Error(`unexpected git call: ${label}`)
      }
      return value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value })
    }
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return reply(responses.branch, 'branch --show-current')
      }
      if (args[0] === 'rev-parse' && args.includes('--quiet')) {
        const probed = args.find((arg) => arg.endsWith('^{commit}')) ?? ''
        return reply(responses.probe?.[probed], `probe ${probed}`)
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return reply(responses.headOid, 'rev-parse HEAD')
      }
      if (args[0] === 'rev-parse') {
        return reply(responses.baseOid, `rev-parse ${args.at(-1)}`)
      }
      if (args[0] === 'merge-base') {
        responses.onMergeBase?.()
        return reply(responses.mergeBase, 'merge-base')
      }
      if (args.includes('--raw')) {
        const raw =
          typeof responses.nameStatus === 'string'
            ? responses.nameStatus
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => {
                  const [status, ...paths] = line.split('\t')
                  return `:100644 100644 a b ${status}\0${paths.join('\0')}\0`
                })
                .join('')
            : responses.nameStatus
        if (raw instanceof Error) {
          return reply(raw, 'diff')
        }
        if (responses.numstat instanceof Error) {
          return reply(responses.numstat, 'diff')
        }
        return reply((raw ?? '') + (responses.numstat ?? ''), 'diff')
      }
      if (args[0] === 'rev-list') {
        return reply(responses.revList, 'rev-list')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
  }

  it('keeps cancellation effective when equal-tip validation settles', async () => {
    const oid = 'a'.repeat(40)
    const controller = new AbortController()
    mockBranchCompareGit({
      branch: 'feature\n',
      probe: { 'refs/remotes/origin/main^{commit}': `${oid}\n` },
      headOid: `${oid}\n`,
      baseOid: `${oid}\n`,
      mergeBase: `${oid}\n`,
      onMergeBase: () => controller.abort(new Error('compare canceled'))
    })

    await expect(
      getBranchCompare('/repo', 'origin/main', { signal: controller.signal })
    ).resolves.toMatchObject({
      summary: { status: 'error', errorMessage: 'compare canceled' },
      entries: []
    })
    expect(
      gitExecFileAsyncMock.mock.calls.some(([args]) => ['diff', 'rev-list'].includes(args[0]))
    ).toBe(false)
  })

  // Keep distinct probe results to catch accidental reuse of the losing ref's OID.
})
