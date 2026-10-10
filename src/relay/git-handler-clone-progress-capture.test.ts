import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { createFakeSpawnedChild } from '../shared/__fixtures__/fake-spawned-child'
import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'
import { createGitHandlerRelay } from './git-handler-test-harness'
import { _resetRelayGitAdmissionForTests } from './git-handler-command-termination'

const { spawn, signalTree, forceTree } = vi.hoisted(() => ({
  spawn: vi.fn<(program: string, args: readonly string[]) => ChildProcess>(),
  signalTree: vi.fn<(child: ChildProcess, signal?: NodeJS.Signals) => Promise<boolean>>(),
  forceTree: vi.fn<(child: ChildProcess) => Promise<boolean>>()
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn
}))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalTree,
  forceTerminateProcessTree: forceTree
}))

const request = {
  args: ['clone', '--progress', '--', 'https://example.com/repository.git', 'destination'],
  cwd: process.cwd(),
  progressId: 'clone-progress'
}
const noise = Buffer.from(`Receiving objects: 42%\r${'x'.repeat(65_512)}\r`)

function emitNoise(child: ChildProcess): void {
  for (let index = 0; index < 193; index++) {
    child.stderr?.emit('data', noise)
  }
}

describe('relay clone progress capture', () => {
  let relay: ReturnType<typeof createGitHandlerRelay>
  let scheduler: GitAdmissionScheduler
  let child: ChildProcess

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
    scheduler = new GitAdmissionScheduler({ networkCap: 1, networkHeadroom: 0 })
    _resetRelayGitAdmissionForTests(scheduler)
    child = createFakeSpawnedChild()
    spawn.mockReset().mockReturnValue(child)
    signalTree.mockReset().mockResolvedValue(false)
    forceTree.mockReset().mockResolvedValue(false)
    relay = createGitHandlerRelay()
  })

  afterEach(() => {
    relay.handler.dispose()
    _resetRelayGitAdmissionForTests()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('completes after more than 10 MiB of progress with bounded final output', async () => {
    const pending = relay.dispatcher.callRequest('git.clone', request)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledOnce()
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(1)
    expect(noise.length * 193).toBeGreaterThan(10 * 1024 * 1024)
    emitNoise(child)
    const finalStderr = 'Receiving objects: 100%\rCLONE_FINAL_TAIL\n'
    child.stderr?.emit('data', Buffer.from(finalStderr))
    child.stdout?.emit('data', Buffer.from(`${'o'.repeat(8192)}STDOUT_FINAL\n`))
    expect(signalTree).not.toHaveBeenCalled()
    expect(forceTree).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    child.emit('close', 0, null)

    await expect(pending).resolves.toEqual({
      stdout: `${'o'.repeat(8192)}STDOUT_FINAL\n`.slice(-4096),
      stderr: `${noise.toString()}${finalStderr}`.slice(-4096)
    })
    expect(relay.dispatcher.notify).toHaveBeenCalledTimes(194)
    expect(relay.dispatcher.notify).toHaveBeenLastCalledWith('git.cloneProgress', {
      progressId: request.progressId,
      phase: 'Receiving objects',
      percent: 100
    })
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the final fatal diagnostic after noisy progress and exit 128', async () => {
    const pending = relay.dispatcher.callRequest('git.clone', request)
    const rejection = expect(pending).rejects.toThrow('Clone failed: fatal: repository unavailable')
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledOnce()
    emitNoise(child)
    child.stderr?.emit('data', Buffer.from('fatal: repository unavailable\n'))
    child.emit('exit', 128, null)
    child.emit('close', 128, null)
    await rejection
    expect(signalTree).not.toHaveBeenCalled()
    expect(forceTree).not.toHaveBeenCalled()
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds admission on cancellation until the clone tree is confirmed terminated', async () => {
    let confirmTermination: (terminated: boolean) => void = () => {
      throw new Error('Termination verification has not started')
    }
    forceTree.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirmTermination = resolve
        })
    )
    const controller = new AbortController()
    const pending = relay.dispatcher.callRequest('git.clone', request, {
      isStale: () => false,
      signal: controller.signal
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledOnce()
    emitNoise(child)
    expect(signalTree).not.toHaveBeenCalled()
    controller.abort()
    await vi.advanceTimersByTimeAsync(2000)
    expect(signalTree).toHaveBeenCalledWith(child, undefined)
    expect(forceTree).toHaveBeenCalledWith(child)
    expect(settled).toBe(false)
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(1)

    confirmTermination(true)
    await vi.advanceTimersByTimeAsync(0)
    await rejection
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(0)
    child.emit('exit', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
