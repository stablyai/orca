import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildProcessModule from '../../../worker-thread-child-process/worker-thread-child-process'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import type { GhExecOptions } from '../../../git/command-runner/hosted-cli/gh-exec-file'

const { groupExists } = vi.hoisted(() => ({ groupExists: vi.fn(() => true) }))

const { spawnMock, resolverMock, signalMock, forceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolverMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
// These tests drive the in-thread spawn mocks; keep Windows launches off the real process worker.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WorkerChildProcessModule>()),
    canSpawnOnWorkerThread: () => false
  })
)
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  processGroupExists: groupExists,
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../../repositories/github-api-repository', () => ({
  resolveGitHubRepoExecution: resolverMock
}))
import { getPRCheckDetails } from './get-pr-check-details'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhCapabilityStateForTests } from '../../accounts/gh-capability-state'
import { clearGhAccountTokenCacheForTests } from '../../accounts/gh-account-token'

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
    groupExists.mockReturnValue(true)
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
      groupExists.mockReturnValue(false)
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
    groupExists.mockReturnValue(false)
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
    groupExists.mockReturnValue(false)
    logChildren[0].emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    await expect(fifth).resolves.toMatchObject({ jobs: [{ logTail: 'Error: fifth' }] })
    expect(logChildren).toHaveLength(5)
  })

  it('keeps queued check details waiting until abandoned credential lookup exits', async () => {
    const options: GhExecOptions = {
      cwd: '/folder',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: {}
    }
    resolverMock.mockResolvedValue({ ownerRepo: repo, ghOptions: options })
    const help = Promise.withResolvers<ChildProcess>()
    const token = Promise.withResolvers<ChildProcess>()
    spawnMock.mockImplementation((_program: string, argv: string[]) => {
      const child = spawn()
      if (argv[0] === 'auth') {
        if (argv.includes('--help')) {
          help.resolve(child)
        } else {
          token.resolve(child)
        }
      } else {
        const stdout = argv.some((arg) => arg.includes('/annotations?'))
          ? '[]'
          : '{"name":"queued check"}'
        queueMicrotask(() => completeFakeSpawn(child, { stdout }))
      }
      return child
    })
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const results = controllers.map((controller) =>
      getPRCheckDetails('/folder', { checkRunId: 1 }, undefined, {}, controller.signal).catch(
        () => null
      )
    )
    await vi.advanceTimersByTimeAsync(0)
    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(results)
    resolverMock.mockResolvedValue({ ownerRepo: repo, ghOptions: { cwd: '/folder', env: {} } })
    let queuedSettled = false
    const queued = getPRCheckDetails('/folder', { checkRunId: 5 }).finally(() => {
      queuedSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(queuedSettled).toBe(false)
    completeFakeSpawn(await help.promise, { stdout: '--user' })
    await vi.advanceTimersByTimeAsync(0)
    const tokenChild = await token.promise
    tokenChild.emit('error', new Error('token delivery failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(queuedSettled).toBe(false)
    groupExists.mockReturnValue(false)
    tokenChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    await expect(queued).resolves.toMatchObject({ name: 'queued check' })
  })
})
