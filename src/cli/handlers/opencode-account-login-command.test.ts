import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { InteractiveLoginSession } from './interactive-login-interruption'

const { spawn, signalTree, forceTree, inFlightKill } = vi.hoisted(() => ({
  spawn: vi.fn(),
  signalTree: vi.fn(),
  forceTree: vi.fn(),
  inFlightKill: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalTree,
  forceTerminateProcessTree: forceTree
}))
vi.mock('@orca/process-host/windows-tree-kill', () => ({ inFlightWindowsTreeKill: inFlightKill }))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: (command: string) => command,
  withCliRuntimeOnPath: (_command: string, env: NodeJS.ProcessEnv) => env
}))
import { resolveOpenCodeLoginCommand } from './opencode-account-login-command'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  vi.resetAllMocks()
})
function probe() {
  return Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}
function session(): InteractiveLoginSession {
  return { child: null, registering: false, terminationPromise: null }
}

it('a timely root exit clears execution timeout while trailing help drains, then releases late events', async () => {
  vi.useFakeTimers()
  const child = probe()
  spawn.mockReturnValue(child)
  const owner = session()
  const pending = resolveOpenCodeLoginCommand({}, owner)
  await vi.advanceTimersByTimeAsync(9_900)
  child.emit('exit', 0)
  await vi.advanceTimersByTimeAsync(200)
  child.stderr.write('--standalone  trailing help')
  expect(signalTree).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(800)
  await expect(pending).resolves.toBe('opencode2')
  expect(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed).toBe(true)
  expect(owner).toMatchObject({ child: null, stopPhase: undefined, terminationPromise: null })
  // Late errors/close from this released handle cannot affect a later owner.
  const next = probe()
  owner.child = next
  child.emit('error', new Error('late error'))
  child.emit('close', 0)
  expect(owner.child).toBe(next)
  expect(vi.getTimerCount()).toBe(0)
})

it('Windows automatic timeout joins tracked tree lifetime beyond the caller wait before fallback', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const first = Object.assign(probe(), { pid: 4321 })
  const second = probe()
  spawn.mockReturnValueOnce(first).mockImplementationOnce(() => {
    queueMicrotask(() => {
      second.stdout.write('--standalone')
      second.emit('exit', 0)
      second.emit('close', 0)
    })
    return second
  })
  let finishCallerWait!: (signaled: boolean) => void
  signalTree.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finishCallerWait = resolve
    })
  )
  let finishKill!: () => void
  inFlightKill.mockReturnValue(
    new Promise<void>((resolve) => {
      finishKill = resolve
    })
  )
  const owner = session()
  const pending = resolveOpenCodeLoginCommand({}, owner)
  await vi.advanceTimersByTimeAsync(15_000)
  // Complete the five-second caller wait while the tracked tree operation remains live.
  finishCallerWait(false)
  first.emit('exit', null)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(first.kill).not.toHaveBeenCalled()
  expect(first.stdout.destroyed).toBe(false)
  expect(owner.terminationPromise).toBeNull()
  finishKill()
  await expect(pending).resolves.toBe('opencode')
  expect(first.stdout.destroyed && first.stderr.destroyed).toBe(true)
  expect(signalTree).toHaveBeenCalledTimes(1)
  expect(forceTree).not.toHaveBeenCalled()
  expect(spawn.mock.calls.every(([spec]) => spec.detached === false)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('asynchronous spawn error releases readers before synchronous fallback failure and final refusal', async () => {
  const child = probe()
  spawn
    .mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    })
    .mockImplementationOnce(() => {
      throw new Error('unlaunchable fallback')
    })
  const owner = session()
  await expect(resolveOpenCodeLoginCommand({}, owner)).rejects.toThrow(
    'Install alongside your existing CLI'
  )
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed).toBe(true)
  expect(owner.child).toBeNull()
  expect(owner.stopPhase).toBeUndefined()
  expect(signalTree).not.toHaveBeenCalled()
  child.emit('error', new Error('late error'))
  child.emit('exit', 0)
  child.emit('close', 0)
})
