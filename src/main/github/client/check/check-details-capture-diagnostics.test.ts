import '../../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import type { ChildProcess } from 'node:child_process'
import { getEventListeners } from 'node:events'
import type * as ProcessHostModule from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import * as capture from '../../../git/command-runner/exec-file-capture'
import { RpcDispatcher } from '../../../runtime/rpc/dispatcher'
import { GITHUB_PULL_REQUEST_METHODS } from '../../../runtime/rpc/methods/github-pull-request-methods'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import * as ghUtils from '../../gh-utils'
import { getPRCheckDetails } from './get-pr-check-details'
import { prCheckLogTailCache } from './check-job-log-tails'

const { spawnMock, resolverMock, signalMock, forceMock, captureCap } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolverMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn(),
  captureCap: { bytes: 4096, metadata: false }
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    runProcess: (spec: Parameters<typeof actual.runProcess>[0]) => {
      if (spec.signal) {
        signals.add(spec.signal)
      }
      const limited = captureCap.metadata || spec.args?.some((arg) => arg.endsWith('/logs'))
      return actual.runProcess({
        ...spec,
        maxOutputBytes: limited ? captureCap.bytes : spec.maxOutputBytes
      })
    }
  }
})
const children: ChildProcess[] = []
const signals = new Set<AbortSignal>()
const sentinels = {
  message: 'PRIVATE_CAPTURE_MESSAGE',
  stdout: 'PRIVATE_CAPTURE_STDOUT',
  stderr: 'PRIVATE_CAPTURE_STDERR',
  stack: 'PRIVATE_CAPTURE_STACK',
  cause: 'PRIVATE_CAPTURE_CAUSE',
  reason: 'PRIVATE_CALLER_REASON'
}
const rawDiagnostic = 'raw-capture-diagnostic'
function privateFailure(): Error {
  return Object.assign(new Error(sentinels.message, { cause: new Error(sentinels.cause) }), {
    stack: sentinels.stack,
    stdout: sentinels.stdout,
    stderr: `${sentinels.stderr}\n${rawDiagnostic}`,
    code: 1,
    killed: false,
    signal: null,
    outputTruncated: false
  })
}
function dispatcher(): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'capture-runtime',
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
function serializeDiagnostics(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error
      ? { ...item, name: item.name, message: item.message, stack: item.stack, cause: item.cause }
      : item
  )
}
async function verifyAdmissionIsRestored(): Promise<void> {
  await Promise.all(Array.from({ length: 4 }, () => ghUtils.acquire()))
  let fifthStarted = false
  const fifth = ghUtils.acquire().then(() => {
    fifthStarted = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(fifthStarted).toBe(false)
  ghUtils.release()
  await fifth
  for (let i = 0; i < 4; i++) {
    ghUtils.release()
  }
}
async function verifyAdmissionIsRetained(): Promise<void> {
  await Promise.all(Array.from({ length: 3 }, () => ghUtils.acquire()))
  const controller = new AbortController()
  let started = false
  const waiting = ghUtils.acquire(controller.signal).then(
    () => {
      started = true
      ghUtils.release()
    },
    () => {}
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(started).toBe(false)
  controller.abort()
  await waiting
  for (let i = 0; i < 3; i++) {
    ghUtils.release()
  }
}

describe('real capture and gh diagnostics through check details RPC', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    signals.clear()
    captureCap.bytes = 4096
    captureCap.metadata = false
    prCheckLogTailCache.clear()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    resolverMock.mockReset().mockResolvedValue({
      ownerRepo: { owner: 'acme', repo: 'widgets' },
      ghOptions: { cwd: '/folder', env: { GH_TOKEN: 'fixture-scope' } }
    })
    spawnMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(vi.getTimerCount()).toBe(0)
    for (const signal of signals) {
      expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['ordinary', 'pid-error', 'runner-timeout', 'caller', 'host'] as const)(
    'keeps %s raw capture fields internal and restores actual admission',
    async (mode) => {
      const captureSpy = vi.spyOn(capture, 'execFileCaptureToTermination')
      const ghSpy = vi.spyOn(ghUtils, 'ghExecFileAsync')
      if (mode === 'runner-timeout') {
        resolverMock.mockResolvedValue({
          ownerRepo: { owner: 'acme', repo: 'widgets' },
          ghOptions: { cwd: '/folder', env: { GH_TOKEN: 'fixture-scope' }, timeout: 10 }
        })
        captureCap.bytes = 64
        captureCap.metadata = true
      } else if (mode === 'caller' || mode === 'host') {
        captureCap.bytes = 64
      }
      spawnMock.mockImplementation((_program: string, argv: string[]) => {
        const child = createFakeSpawnedChild(children.length + 1000)
        child.kill = vi.fn(() => false)
        children.push(child)
        const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
        if (mode !== 'runner-timeout' && !endpoint.endsWith('/logs')) {
          const stdout = endpoint.includes('/annotations')
            ? '[]'
            : endpoint.includes('/jobs?')
              ? '{"jobs":[{"id":77,"name":"failed job","status":"completed","conclusion":"failure","completed_at":"done","steps":[{"name":"failed step"}]}]}'
              : '{"name":"retained","output":{"summary":"kept"}}'
          queueMicrotask(() => completeFakeSpawn(child, { stdout }))
        }
        return child
      })
      const controller = new AbortController()
      const result = dispatcher().dispatch(
        {
          id: mode,
          authToken: 'fixture-auth',
          method: 'github.prCheckDetails',
          params: { repo: 'repo', checkRunId: 1, workflowRunId: 2 }
        },
        { signal: controller.signal }
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(children).toHaveLength(mode === 'runner-timeout' ? 1 : 4)
      const child = children.at(-1)
      const captureResult = captureSpy.mock.results.at(-1)
      const ghResult = ghSpy.mock.results.at(-1)
      if (!child || captureResult?.type !== 'return' || ghResult?.type !== 'return') {
        throw new Error('Expected a real pending capture')
      }
      const internalFailure = captureResult.value.catch((error: unknown) => error)
      const runnerFailure = ghResult.value.catch((error: unknown) => error)
      if (mode === 'ordinary') {
        completeFakeSpawn(child, {
          code: 1,
          stdout: sentinels.stdout,
          stderr: `${sentinels.stderr}\n${rawDiagnostic}`
        })
      } else if (mode === 'pid-error') {
        child.stdout?.emit('data', Buffer.from(sentinels.stdout))
        child.stderr?.emit('data', Buffer.from(sentinels.stderr))
        child.emit('error', privateFailure())
        await vi.advanceTimersByTimeAsync(0)
        expect(children).toHaveLength(4)
        child.emit('close', 1, null)
      } else {
        // Lower only the test capture cap; the real sinks still report truncation.
        child.stdout?.emit('data', Buffer.from(sentinels.stdout.repeat(8)))
        child.stderr?.emit('data', Buffer.from(`${sentinels.stderr}\n${rawDiagnostic}`))
        if (mode === 'caller') {
          controller.abort(Object.assign(privateFailure(), { message: sentinels.reason }))
        } else {
          await vi.advanceTimersByTimeAsync(mode === 'host' ? 25_000 : 10)
        }
        if (mode !== 'runner-timeout') {
          await expect(result).resolves.toMatchObject({ ok: false })
        }
        await vi.advanceTimersByTimeAsync(12_000)
        // The physical child still holds admission after unverified grace.
        expect(getEventListeners(child, 'close')).toHaveLength(1)
        await verifyAdmissionIsRetained()
        child.emit('close', null, 'SIGKILL')
      }
      const response = await result
      const error = await internalFailure
      expect(error).toMatchObject({
        stdout: expect.stringContaining(sentinels.stdout),
        stderr: expect.stringContaining(sentinels.stderr)
      })
      expect(error).toMatchObject({ outputTruncated: !['ordinary', 'pid-error'].includes(mode) })
      expect(await runnerFailure).toMatchObject({
        outputTruncated: !['ordinary', 'pid-error'].includes(mode)
      })
      if (mode === 'ordinary') {
        expect(error).toMatchObject({ code: 1, killed: false, signal: null })
      }
      if (mode === 'pid-error') {
        expect(error).toMatchObject({
          message: sentinels.message,
          stack: sentinels.stack,
          cause: expect.any(Error)
        })
      }
      if (mode === 'ordinary' || mode === 'pid-error') {
        expect(response).toMatchObject({
          ok: true,
          result: {
            name: 'retained',
            summary: 'kept',
            jobs: [
              {
                id: 77,
                name: 'failed job',
                logTail: null,
                logState: 'error',
                steps: [{ name: 'failed step' }]
              }
            ]
          }
        })
        expect(vi.mocked(console.warn).mock.calls).toEqual([
          ['getPRCheckDetails', 'job_log_failed']
        ])
      } else {
        expect(response).toMatchObject({
          ok: false,
          error: {
            message:
              mode === 'host'
                ? 'Timed out loading check details.'
                : mode === 'caller'
                  ? 'Check details request was cancelled.'
                  : 'Could not load check details.'
          }
        })
        expect(vi.mocked(console.warn).mock.calls).toContainEqual([
          'getPRCheckDetails',
          mode === 'host' ? 'deadline' : mode === 'caller' ? 'cancelled' : 'request_failed'
        ])
        if (mode === 'runner-timeout') {
          expect(
            vi
              .mocked(console.warn)
              .mock.calls.some(([message]) =>
                String(message).includes('[gh] killed at its 10ms deadline')
              )
          ).toBe(true)
        }
      }
      const serialized = serializeDiagnostics([response, vi.mocked(console.warn).mock.calls])
      for (const sentinel of Object.values(sentinels)) {
        expect(serialized).not.toContain(sentinel)
      }
      expect(serialized).not.toContain(rawDiagnostic)
      expect(prCheckLogTailCache.size).toBe(0)
      await vi.advanceTimersByTimeAsync(0)
      await verifyAdmissionIsRestored()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
