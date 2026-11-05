import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'

const stops = vi.hoisted(() => ({ supervised: vi.fn(), windows: vi.fn() }))
vi.mock('../pty/native/windows-process-arguments', () => ({
  UnsafeWindowsBatchArgumentsError: class extends Error {}
}))
vi.mock('../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: stops.windows
}))
vi.mock('../provider-process/supervised-child-process-stop', () => ({
  stopSupervisedChildProcess: stops.supervised
}))
vi.mock('../network/macos-tailscale-dns-diagnostic', () => ({
  withMacTailscaleDnsHint: (message: string) => message
}))

import { withCodexHomeProcessLock } from '../codex-cli/codex-home-process-lock'
import {
  beginLocalGenerationRequest,
  type LocalGenerationRequest
} from './source-control-generation-lanes'
import { runLocalPlanForAgent } from './source-control-local-generation'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { runGenerationRequest } from './agent-generation-request'

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override exitCode: number | null = null
  override signalCode: NodeJS.Signals | null = null
  override kill = vi.fn(() => true)
  supervised = false
  readonly endInput = vi.spyOn(this.stdin, 'end')

  constructor(pid: number | null = 12345) {
    super()
    if (pid !== null) {
      Object.defineProperty(this, 'pid', { value: pid })
    }
  }

  finish(stdout = 'Update README', stderr = '', code = 0): void {
    this.stdout.emit('data', Buffer.from(stdout))
    this.stderr.emit('data', Buffer.from(stderr))
    this.exitCode = code
    this.emit('exit', code)
    this.emit('close', code)
  }
}

const plan: CommitMessagePlan = {
  binary: 'codex',
  args: ['exec'],
  stdinPayload: 'ordinary prompt',
  label: 'Codex'
}
const cwd = '/same-repo'
const home = '/offline-process-test-account'
const liveRequests: LocalGenerationRequest[] = []
let children: FakeChild[] = []
let spawn = vi.fn(() => new FakeChild())
let sequence = 0
const hostPlatform = process.platform

function request(): LocalGenerationRequest {
  const value = beginLocalGenerationRequest('commit-message', {
    owner: 'window:one',
    generationId: `request-${++sequence}`
  })
  if (!value) {
    throw new Error('Identified request required')
  }
  value.bindTarget({ cwd })
  liveRequests.push(value)
  return value
}

function start(owner: LocalGenerationRequest) {
  return runLocalPlanForAgent({
    agentId: 'codex',
    plan,
    target: { kind: 'local', cwd, env: { CODEX_HOME: home }, generationRequest: owner },
    operation: 'commit-message',
    spawnAgent: spawn
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  children = []
  spawn = vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  stops.supervised.mockResolvedValue(undefined)
  stops.windows.mockResolvedValue(undefined)
})

afterEach(async () => {
  for (const child of children) {
    child.finish()
  }
  for (const owner of liveRequests.splice(0)) {
    owner.release()
  }
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.useRealTimers()
  await nextTurn()
})

describe('Exact request ownership through the Codex queue and process', () => {
  it('canceled queued A never starts or replaces live B at the same operation and cwd', async () => {
    const held = Promise.withResolvers<void>()
    const blocker = withCodexHomeProcessLock(home, () => held.promise)
    const a = request()
    const b = request()
    const resultA = start(a)
    const resultB = start(b)
    a.cancelForTarget({ cwd })
    await expect(resultA).resolves.toMatchObject({ canceled: true })
    a.release()
    expect(spawn).not.toHaveBeenCalled()
    held.resolve()
    await blocker
    await nextTurn()
    expect(children).toHaveLength(1)
    a.cancelForTarget({ cwd })
    expect(children[0].kill).not.toHaveBeenCalled()
    b.cancelForTarget({ cwd })
    await expect(resultB).resolves.toMatchObject({ canceled: true })
    expect(children[0].kill).toHaveBeenCalledOnce()
    children[0].finish()
    await nextTurn()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('Stop B while A runs cancels only B in the same operation/cwd queue', async () => {
    const a = request()
    const b = request()
    const resultA = start(a)
    await nextTurn()
    const resultB = start(b)
    b.cancelForTarget({ cwd })
    await expect(resultB).resolves.toMatchObject({ canceled: true })
    expect(children).toHaveLength(1)
    expect(children[0].kill).not.toHaveBeenCalled()
    children[0].finish()
    await expect(resultA).resolves.toMatchObject({ success: true })
    await nextTurn()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it.each(['exit-first', 'termination-first'] as const)(
    'canceled result retains home lock until process exit and supervised stop complete (%s)',
    async (order) => {
      const termination = Promise.withResolvers<void>()
      stops.supervised.mockReturnValue(termination.promise)
      const a = request()
      const b = request()
      const resultA = start(a)
      await nextTurn()
      children[0].supervised = true
      const resultB = start(b)
      a.cancelForTarget({ cwd })
      await expect(resultA).resolves.toMatchObject({ canceled: true })
      expect(stops.supervised).toHaveBeenCalledOnce()
      expect(children[0].kill).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledOnce()
      if (order === 'exit-first') {
        children[0].finish()
      } else {
        termination.resolve()
      }
      await nextTurn()
      expect(spawn).toHaveBeenCalledOnce()
      if (order === 'exit-first') {
        termination.resolve()
      } else {
        children[0].finish()
      }
      await nextTurn()
      expect(children).toHaveLength(2)
      a.cancelForTarget({ cwd })
      expect(children[1].kill).not.toHaveBeenCalled()
      children[1].finish()
      await expect(resultB).resolves.toMatchObject({ success: true })
    }
  )

  it('cancellation during spawn initializes cleanup before attachment and skips stdin', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = request()
    const b = request()
    spawn.mockImplementationOnce(() => {
      const child = new FakeChild()
      children.push(child)
      a.cancelForTarget({ cwd })
      return child
    })
    const resultA = start(a)
    await expect(resultA).resolves.toMatchObject({ canceled: true })
    const resultB = start(b)
    expect(children[0].endInput).not.toHaveBeenCalled()
    expect(children[0].stdout.listenerCount('data')).toBe(0)
    expect(children[0].stderr.listenerCount('data')).toBe(0)
    children[0].emit('error', new Error('late canceled process error'))
    expect(children[0].listenerCount('close')).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(children[0].kill).toHaveBeenCalledOnce()
    await nextTurn()
    expect(spawn).toHaveBeenCalledOnce()
    children[0].finish()
    await nextTurn()
    expect(children).toHaveLength(2)
    children[1].finish()
    await expect(resultB).resolves.toMatchObject({ success: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a request canceled before the plan starts never spawns', async () => {
    const owner = request()
    owner.cancelForTarget({ cwd })
    await expect(start(owner)).resolves.toMatchObject({ canceled: true })
    await nextTurn()
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['close-first', 'termination-first'] as const)(
    'Windows cancellation retains home lock until tree termination and close (%s)',
    async (order) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const termination = Promise.withResolvers<void>()
      stops.windows.mockReturnValue(termination.promise)
      const a = request()
      const b = request()
      const resultA = start(a)
      await nextTurn()
      const resultB = start(b)
      a.cancelForTarget({ cwd })
      await expect(resultA).resolves.toMatchObject({ canceled: true })
      expect(stops.windows).toHaveBeenCalledExactlyOnceWith(12345, {
        site: 'source-control-text-generation'
      })
      expect(children[0].kill).not.toHaveBeenCalled()
      if (order === 'close-first') {
        children[0].emit('close', null)
      } else {
        termination.resolve()
      }
      await nextTurn()
      expect(spawn).toHaveBeenCalledOnce()
      expect(children[0].kill).toHaveBeenCalledTimes(order === 'close-first' ? 0 : 1)
      if (order === 'close-first') {
        termination.resolve()
      } else {
        children[0].emit('close', null)
      }
      await nextTurn()
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      expect(children).toHaveLength(2)
      children[1].finish()
      await expect(resultB).resolves.toMatchObject({ success: true })
    }
  )

  it('exit without close releases the home lock only after the started termination completes', async () => {
    const termination = Promise.withResolvers<void>()
    stops.supervised.mockReturnValue(termination.promise)
    const a = request()
    const b = request()
    const resultA = start(a)
    await nextTurn()
    children[0].supervised = true
    const resultB = start(b)
    a.cancelForTarget({ cwd })
    await expect(resultA).resolves.toMatchObject({ canceled: true })
    children[0].signalCode = 'SIGTERM'
    children[0].emit('exit', null, 'SIGTERM')
    await nextTurn()
    expect(children).toHaveLength(1)
    termination.resolve()
    await nextTurn()
    expect(children).toHaveLength(2)
    expect(children[0].listenerCount('close')).toBe(1)
    children[1].finish()
    await expect(resultB).resolves.toMatchObject({ success: true })
  })
})

describe('Exact request cleanup on existing failure paths', () => {
  it.each(['spawn-throw', 'no-pid-error'] as const)(
    'a %s releases the home for a surviving request without process-exit evidence',
    async (failure) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      if (failure === 'spawn-throw') {
        spawn.mockImplementationOnce(() => {
          throw new Error('offline launch failure')
        })
      } else {
        spawn.mockImplementationOnce(() => {
          const child = new FakeChild(null)
          children.push(child)
          return child
        })
      }
      const a = request()
      const resultA = start(a)
      await nextTurn()
      if (failure === 'no-pid-error') {
        children[0].emit('error', Object.assign(new Error('offline ENOENT'), { code: 'ENOENT' }))
      }
      await expect(resultA).resolves.toMatchObject({ success: false, error: expect.any(String) })
      const resultB = start(request())
      await nextTurn()
      expect(spawn).toHaveBeenCalledTimes(2)
      a.cancelForTarget({ cwd })
      expect(children.at(-1)?.kill).not.toHaveBeenCalled()
      children.at(-1)?.finish()
      await expect(resultB).resolves.toMatchObject({ success: true })
    }
  )

  it('stdin-write failure publishes failure but holds the home until the child exits', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    spawn.mockImplementationOnce(() => {
      const child = new FakeChild()
      child.endInput.mockImplementationOnce(() => {
        throw new Error('offline stdin failure')
      })
      children.push(child)
      return child
    })
    const resultA = start(request())
    await expect(resultA).resolves.toMatchObject({ success: false, error: expect.any(String) })
    const resultB = start(request())
    await nextTurn()
    expect(children).toHaveLength(1)
    expect(children[0].kill).toHaveBeenCalledOnce()
    expect(children[0].stdout.listenerCount('data')).toBe(0)
    children[0].emit('error', new Error('late canceled process error'))
    children[0].finish()
    await nextTurn()
    expect(children).toHaveLength(2)
    children[1].finish()
    await expect(resultB).resolves.toMatchObject({ success: true })
  })

  it('a PID-bearing error keeps the home occupied until process exit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const resultA = start(request())
    await nextTurn()
    children[0].emit('error', new Error('offline PID-bearing process error'))
    await expect(resultA).resolves.toMatchObject({ success: false, error: expect.any(String) })
    const resultB = start(request())
    await nextTurn()
    expect(children).toHaveLength(1)
    expect(children[0].stdout.listenerCount('data')).toBe(0)
    children[0].emit('error', new Error('late canceled process error'))
    children[0].finish()
    await nextTurn()
    expect(children).toHaveLength(2)
    children[1].finish()
    await expect(resultB).resolves.toMatchObject({ success: true })
  })

  it.each(['timeout', 'output-cap'] as const)(
    '%s stops the process and retains the home through process completion',
    async (failure) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const resultA = start(request())
      await nextTurn()
      const resultB = start(request())
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
        await expect(resultA).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining('timed out')
        })
        expect(vi.getTimerCount()).toBe(0)
        expect(children[0].stdout.listenerCount('data')).toBe(0)
      } else {
        children[0].stdout.emit('data', Buffer.alloc(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES + 1))
      }
      await nextTurn()
      expect(children).toHaveLength(1)
      expect(children[0].kill).toHaveBeenCalledOnce()
      children[0].finish()
      if (failure === 'output-cap') {
        await expect(resultA).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining('too much output')
        })
      }
      await nextTurn()
      expect(children).toHaveLength(2)
      children[1].finish()
      await expect(resultB).resolves.toMatchObject({ success: true })
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('OpenCode retry retains the same cancellation owner', () => {
  it.each([true, false])('retryable failure with explicit Stop=%s', async (stop) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const owner = request()
    const result = runGenerationRequest({
      params: { agentId: 'opencode', model: 'provider/model', thinkingLevel: 'high' },
      prompt: 'ordinary prompt',
      target: { kind: 'local', cwd, generationRequest: owner },
      operation: 'commit-message',
      spawnAgent: spawn
    })
    expect(children).toHaveLength(1)
    children[0].finish('', 'Unrecognized flag: --variant in command opencode run', 1)
    if (stop) {
      owner.cancelForTarget({ cwd })
    }
    await nextTurn()
    if (stop) {
      await expect(result).resolves.toMatchObject({ canceled: true })
      expect(spawn).toHaveBeenCalledOnce()
    } else {
      expect(children).toHaveLength(2)
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: ['run', '--model', 'provider/model#high', '--agent', 'build', '--format', 'json']
        })
      )
      children[1].finish(
        JSON.stringify({ type: 'text', part: { id: 'answer', text: 'Update README' } })
      )
      await expect(result).resolves.toMatchObject({ success: true, rawOutput: 'Update README' })
    }
  })
})

describe('Budgeted requests through the Codex queue and process', () => {
  function budgeted(owner: LocalGenerationRequest, spawnAllowed?: () => boolean) {
    const budget = owner.startBudget({ cwd })
    return runLocalPlanForAgent({
      agentId: 'codex',
      plan,
      target: {
        kind: 'local',
        cwd,
        env: { CODEX_HOME: home },
        generationRequest: owner,
        request: budget,
        ...(spawnAllowed
          ? {
              accountAttempt: {
                accountId: 'a',
                identity: 'a',
                model: '',
                env: { CODEX_HOME: home },
                spawnAllowed,
                configurePlan: (input: CommitMessagePlan) => input,
                valid: () => true
              }
            }
          : {})
      },
      operation: 'commit-message',
      spawnAgent: spawn
    })
  }

  it('Stop while waiting for the home lock settles promptly and never spawns', async () => {
    const held = Promise.withResolvers<void>()
    const blocker = withCodexHomeProcessLock(home, () => held.promise)
    const owner = request()
    const result = budgeted(owner)
    await nextTurn()
    owner.cancelForTarget({ cwd })
    await expect(result).resolves.toMatchObject({ canceled: true })
    held.resolve()
    await blocker
    await nextTurn()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('an account change while waiting for the home lock reports it instead of a silent cancel', async () => {
    const held = Promise.withResolvers<void>()
    const blocker = withCodexHomeProcessLock(home, () => held.promise)
    let allowed = true
    const result = budgeted(request(), () => allowed)
    await nextTurn()
    allowed = false
    held.resolve()
    await blocker
    const settled = await result
    expect(settled).toMatchObject({
      success: false,
      subscriptionAccountChanged: true,
      errorCode: 'generationAccountChanged'
    })
    expect(settled).not.toHaveProperty('canceled')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('the deadline while waiting for the home lock reports a timeout, not a cancel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = Promise.withResolvers<void>()
    const blocker = withCodexHomeProcessLock(home, () => held.promise)
    const result = budgeted(request())
    await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    const settled = await result
    expect(settled).toMatchObject({ success: false, errorCode: 'timedOut' })
    expect(settled).not.toHaveProperty('canceled')
    held.resolve()
    await blocker
    expect(spawn).not.toHaveBeenCalled()
  })

  it('exit with pipes held open by a descendant settles after the stdio grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = budgeted(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    children[0].stdout.emit('data', Buffer.from('Update README'))
    children[0].exitCode = 0
    children[0].emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1_000)
    const next = budgeted(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toMatchObject({ success: true, rawOutput: 'Update README' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    children[1].finish()
    await expect(next).resolves.toMatchObject({ success: true })
  })

  it('the stdio grace holds the home lock until the supervised group sweep finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const swept = Promise.withResolvers<void>()
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new FakeChild(), { supervised: true, groupSwept: swept.promise })
      children.push(child)
      return child
    })
    const result = budgeted(request())
    await vi.advanceTimersByTimeAsync(0)
    const [first] = children
    first.stdout.emit('data', Buffer.from('Update README'))
    first.exitCode = 0
    first.emit('exit', 0)
    const next = budgeted(request())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(stops.supervised).toHaveBeenCalledWith(first, expect.anything())
    expect(first.stdin.destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(1)
    swept.resolve()
    await expect(result).resolves.toMatchObject({ success: true, rawOutput: 'Update README' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    children[1].finish()
    await expect(next).resolves.toMatchObject({ success: true })
  })
})
