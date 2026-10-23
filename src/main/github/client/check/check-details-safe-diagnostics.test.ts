import '../../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhExecOptions } from '../../../git/command-runner/gh-exec-file'
import { RpcDispatcher } from '../../../runtime/rpc/dispatcher'
import { GITHUB_PULL_REQUEST_METHODS } from '../../../runtime/rpc/methods/github-pull-request-methods'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
const { ghMock, resolverMock } = vi.hoisted(() => ({ ghMock: vi.fn(), resolverMock: vi.fn() }))
vi.mock('../../gh-utils', () => ({ ghExecFileAsync: ghMock, acquire: vi.fn(), release: vi.fn() }))
vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
import { getPRCheckDetails } from './get-pr-check-details'
import { prCheckLogTailCache } from './check-job-log-tails'

const sentinels = [
  'PRIVATE_MESSAGE',
  'PRIVATE_STDOUT',
  'PRIVATE_STDERR',
  'PRIVATE_STACK',
  'PRIVATE_CAUSE',
  'PRIVATE_REASON'
]
function failure(): Error {
  return Object.assign(new Error(sentinels[0], { cause: new Error(sentinels[4]) }), {
    stdout: sentinels[1],
    stderr: sentinels[2],
    stack: sentinels[3]
  })
}
function success(argv: string[]): { stdout: string; stderr: string } {
  const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
  if (endpoint.includes('/check-runs/') && !endpoint.includes('/annotations')) {
    return { stdout: '{"name":"retained","output":{"summary":"kept"}}', stderr: '' }
  }
  if (endpoint.includes('/jobs?')) {
    return {
      stdout:
        '{"jobs":[{"id":1,"name":"job","status":"completed","conclusion":"failure","completed_at":"done","steps":[{"name":"failed"}]}]}',
      stderr: ''
    }
  }
  return { stdout: endpoint.includes('/logs') ? 'Error: safe excerpt' : '[]', stderr: '' }
}
function dispatcher(): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getRepoPRCheckDetails: (
      _repo: string,
      args: Parameters<typeof getPRCheckDetails>[1],
      signal?: AbortSignal
    ) => getPRCheckDetails('/folder', args, undefined, {}, signal)
  }
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This explicit registry invokes only getRuntimeId and getRepoPRCheckDetails.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: GITHUB_PULL_REQUEST_METHODS
  })
}

describe('check details outward diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolverMock
      .mockReset()
      .mockResolvedValue({ ownerRepo: { owner: 'acme', repo: 'widgets' }, ghOptions: { env: {} } })
    ghMock.mockReset().mockImplementation(async (argv: string[]) => success(argv))
    prCheckLogTailCache.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['resolution', 'check', 'json', 'annotations', 'jobs', 'log'])(
    'keeps captured output out of %s catch and actual RPC response',
    async (stage) => {
      if (stage === 'resolution') {
        resolverMock.mockRejectedValue(failure())
      } else {
        ghMock.mockImplementation(async (argv: string[]) => {
          const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
          const selected =
            stage === 'check' || stage === 'json'
              ? endpoint.endsWith('/check-runs/1')
              : stage === 'annotations'
                ? endpoint.includes('/annotations')
                : stage === 'jobs'
                  ? endpoint.includes('/jobs?')
                  : endpoint.includes('/logs')
          if (selected) {
            if (stage === 'json') {
              return { stdout: sentinels[1], stderr: '' }
            }
            throw failure()
          }
          return success(argv)
        })
      }
      const response = await dispatcher().dispatch({
        id: 'one',
        authToken: 'test',
        method: 'github.prCheckDetails',
        params: { repo: 'repo', checkRunId: 1, workflowRunId: 2 }
      })
      const serialized = JSON.stringify([response, vi.mocked(console.warn).mock.calls])
      for (const sentinel of sentinels) {
        expect(serialized).not.toContain(sentinel)
      }
      if (['resolution', 'check', 'json'].includes(stage)) {
        expect(response).toMatchObject({
          ok: false,
          error: { message: 'Could not load check details.' }
        })
      } else {
        expect(response).toMatchObject({ ok: true, result: { name: 'retained', summary: 'kept' } })
      }
      if (stage === 'log') {
        expect(response).toMatchObject({
          result: { jobs: [{ id: 1, name: 'job', logTail: null }] }
        })
      }
    }
  )

  it('shared completed log failure keeps captured sentinels out of the actual dispatcher response', async () => {
    resolverMock.mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'widgets' },
      ghOptions: { cwd: '/folder', env: { GH_TOKEN: 'scope-fixture' } }
    })
    ghMock.mockImplementation(async (argv: string[]) => {
      if (argv.some((arg) => arg.endsWith('/logs'))) {
        throw failure()
      }
      return success(argv)
    })
    const response = await dispatcher().dispatch({
      id: 'shared',
      authToken: 'test',
      method: 'github.prCheckDetails',
      params: { repo: 'repo', workflowRunId: 2 }
    })
    expect(response).toMatchObject({
      ok: true,
      result: { jobs: [{ logState: 'error', logTail: null }] }
    })
    for (const sentinel of sentinels) {
      expect(JSON.stringify([response, vi.mocked(console.warn).mock.calls])).not.toContain(sentinel)
    }
    expect(prCheckLogTailCache.size).toBe(0)
  })

  it.each(
    ['caller', 'host'].flatMap((mode) =>
      ['check', 'annotations', 'jobs', 'log'].map((stage) => ({ mode, stage }))
    )
  )(
    'bounds pending $stage and returns fixed $mode cancellation through dispatcher',
    async ({ mode, stage }) => {
      const controller = new AbortController()
      ghMock.mockImplementation((argv: string[], _options: GhExecOptions) => {
        const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
        const selected =
          stage === 'check'
            ? endpoint.endsWith('/check-runs/1')
            : stage === 'annotations'
              ? endpoint.includes('/annotations')
              : stage === 'jobs'
                ? endpoint.includes('/jobs?')
                : endpoint.includes('/logs')
        return selected ? new Promise(() => {}) : Promise.resolve(success(argv))
      })
      const result = dispatcher().dispatch(
        {
          id: 'one',
          authToken: 'test',
          method: 'github.prCheckDetails',
          params: { repo: 'repo', checkRunId: 1, workflowRunId: 2 }
        },
        { signal: controller.signal }
      )
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'caller') {
        controller.abort(new Error(sentinels[5]))
      } else {
        await vi.advanceTimersByTimeAsync(25_000)
      }
      const response = await result
      expect(response).toMatchObject({
        ok: false,
        error: {
          message:
            mode === 'caller'
              ? 'Check details request was cancelled.'
              : 'Timed out loading check details.'
        }
      })
      const serialized = JSON.stringify([response, vi.mocked(console.warn).mock.calls])
      for (const sentinel of sentinels) {
        expect(serialized).not.toContain(sentinel)
      }
    }
  )
})
