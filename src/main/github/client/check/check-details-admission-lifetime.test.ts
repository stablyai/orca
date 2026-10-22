import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import type { GhExecOptions } from '../../../git/command-runner/gh-exec-file'

const { spawnMock, resolverMock, signalMock, forceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolverMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
import { getPRCheckDetails } from './get-pr-check-details'
import {
  createCheckDetailsAdmissionLifetime,
  runCheckDetailsCall
} from './check-details-admission-lifetime'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhCapabilityStateForTests } from '../../gh-capability-state'
import { clearGhAccountTokenCacheForTests } from '../../gh-account-token'

const repo = { owner: 'acme', repo: 'widgets' }
const children: ChildProcess[] = []
function spawn(): ChildProcess {
  const child = createFakeSpawnedChild(children.length + 100)
  child.kill = vi.fn(() => false)
  children.push(child)
  return child
}

describe('check details existing admission ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    spawnMock.mockReset().mockImplementation(spawn)
    resolverMock
      .mockReset()
      .mockResolvedValue({ ownerRepo: repo, ghOptions: { cwd: '/folder', env: {} } })
    signalMock.mockResolvedValue(false)
    forceMock.mockResolvedValue(false)
    clearGhCapabilityStateForTests()
    clearGhAccountTokenCacheForTests()
    prCheckLogTailCache.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not admit a fifth request after four public aborts and unverified grace', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const results = controllers.map((controller, i) =>
      getPRCheckDetails('/folder', { checkRunId: i + 1 }, undefined, {}, controller.signal).catch(
        (error: unknown) => error
      )
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(4)
    const fifth = getPRCheckDetails('/folder', { checkRunId: 5 })
    for (const controller of controllers) {
      controller.abort('secret-reason')
    }
    await vi.advanceTimersByTimeAsync(0)
    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({
        name: 'AbortError',
        message: 'Check details request was cancelled.'
      })
    }
    await vi.advanceTimersByTimeAsync(12_000)
    expect(children).toHaveLength(4)
    children[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(5)
    completeFakeSpawn(children[4], { stdout: '{"name":"fifth"}' })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[5], { stdout: '[]' })
    await expect(fifth).resolves.toMatchObject({ name: 'fifth' })
  })

  it('keeps four actual log captures admitted after subscriber abort and grace, with no late cache publication', async () => {
    const logChildren: ChildProcess[] = []
    spawnMock.mockImplementation((_program: string, argv: string[]) => {
      const child = spawn()
      const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint.endsWith('/logs')) {
        logChildren.push(child)
        if (logChildren.length === 5) {
          queueMicrotask(() => completeFakeSpawn(child, { stdout: 'Error: fifth' }))
        }
      } else {
        const id = children.length
        queueMicrotask(() =>
          completeFakeSpawn(child, {
            stdout: JSON.stringify({
              jobs: [
                {
                  id,
                  name: 'job',
                  status: 'completed',
                  conclusion: 'failure',
                  completed_at: 'done'
                }
              ]
            })
          })
        )
      }
      return child
    })
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const results = controllers.map((controller, i) =>
      getPRCheckDetails(
        '/folder',
        { workflowRunId: i + 1 },
        undefined,
        {},
        controller.signal
      ).catch(() => null)
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(logChildren).toHaveLength(4)
    const fifth = getPRCheckDetails('/folder', { workflowRunId: 5 })
    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(results)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(logChildren).toHaveLength(4)
    expect(prCheckLogTailCache.size).toBe(0)
    logChildren[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    await expect(fifth).resolves.toMatchObject({ jobs: [{ logTail: 'Error: fifth' }] })
    expect(logChildren).toHaveLength(5)
  })

  it('seals logical continuation separately from actual child and releases exactly once', async () => {
    const release = vi.fn()
    const gate = createCheckDetailsAdmissionLifetime(release)
    const controller = new AbortController()
    let finishResult = (): void => {}
    let finishChild = (): void => {}
    const physical = new Promise<void>((resolve) => {
      finishChild = resolve
    })
    const call = runCheckDetailsCall(
      (hooks) => {
        hooks.onTerminationPending(physical)
        return new Promise<void>((resolve) => {
          finishResult = resolve
        })
      },
      controller.signal,
      gate.retainUntil
    )
    await vi.advanceTimersByTimeAsync(0)
    const rejected = expect(call.result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    gate.finish()
    gate.finish()
    await rejected
    finishChild()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).not.toHaveBeenCalled()
    finishResult()
    await call.terminated
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
  })

  it('prevents the jobs stage after a swallowed annotation PID error until close', async () => {
    const controller = new AbortController()
    const result = getPRCheckDetails(
      '/folder',
      { checkRunId: 1, workflowRunId: 2 },
      undefined,
      {},
      controller.signal
    )
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[0], { stdout: '{"name":"loaded"}' })
    await vi.advanceTimersByTimeAsync(0)
    children[1].emit('error', new Error('private-output'))
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    controller.abort()
    await rejected
    expect(children).toHaveLength(2)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-output')
  })

  it('preserves metadata after an ordinary closed annotation failure and continues jobs', async () => {
    const result = getPRCheckDetails('/folder', { checkRunId: 1, workflowRunId: 2 })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[0], { stdout: '{"name":"loaded","output":{"summary":"retained"}}' })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[1], { code: 1, stderr: 'private-output' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(3)
    completeFakeSpawn(children[2], { stdout: '{"jobs":[]}' })
    await expect(result).resolves.toMatchObject({
      name: 'loaded',
      summary: 'retained',
      annotations: [],
      jobs: []
    })
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-output')
  })

  it('retains all four creator permits through joined help and later token continuations after departure', async () => {
    const options: GhExecOptions = {
      cwd: '/folder',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: {}
    }
    resolverMock.mockResolvedValue({ ownerRepo: repo, ghOptions: options })
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const results = controllers.map((controller) =>
      getPRCheckDetails('/folder', { checkRunId: 1 }, undefined, {}, controller.signal).catch(
        () => null
      )
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    expect(spawnMock.mock.calls[0][1]).toEqual(['auth', 'token', '--help'])
    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(results)
    resolverMock.mockResolvedValue({ ownerRepo: repo, ghOptions: { cwd: '/folder', env: {} } })
    const fifth = getPRCheckDetails('/folder', { checkRunId: 5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    completeFakeSpawn(children[0], { stdout: '--user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(5)
    for (const call of spawnMock.mock.calls.slice(1)) {
      expect(call[1]).toContain('Alice')
    }
    for (const tokenChild of children.slice(1)) {
      tokenChild.emit('error', new Error('token delivery failed'))
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(5)
    children[1].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(6)
    completeFakeSpawn(children[5], { stdout: '{"name":"fifth"}' })
    await vi.advanceTimersByTimeAsync(0)
    completeFakeSpawn(children[6], { stdout: '[]' })
    await expect(fifth).resolves.toMatchObject({ name: 'fifth' })
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(2)
  })
})
