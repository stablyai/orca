import { afterEach, expect, it, vi } from 'vitest'
import { failOnLaunchedAgentExit, type LaunchedAgentExitRuntime } from './launched-agent-exit-watch'

const commandId = '0123456789abcdef0123456789abcdef'
const start = '\x1b]133;C;orca_command=0123456789abcdef0123456789abcdef\x07'
const finish = '\x1b]133;D;130;orca_command=0123456789abcdef0123456789abcdef\x07'

function watch(replay = '', alreadySubmitted = true, agent: 'claude' | null = 'claude') {
  const listeners = new Set<(data: string) => void>()
  let recent = replay
  const runtime: LaunchedAgentExitRuntime = {
    readLaunchedAgentForeground: vi.fn(async () => 'agent' as const),
    readRecentTerminalOutput: () => recent,
    subscribeToTerminalData: (_ptyId, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  let signal: AbortSignal | undefined
  const wait = vi.fn((next: AbortSignal) => {
    signal = next
    return new Promise<void>(() => {})
  })
  const result = failOnLaunchedAgentExit(runtime, 'pty-1', agent ?? undefined, undefined, wait, {
    commandId,
    alreadySubmitted
  }).catch((error: unknown) => error)
  return {
    runtime, result, wait, listeners,
    signal: () => signal,
    emit(data: string) {
      recent += data
      for (const listener of listeners) listener(data)
    }
  }
}

afterEach(() => vi.useRealTimers())

it('reports a shell command outcome without inventing an agent for foreground fallback', async () => {
  const launch = watch('', true, null)
  launch.emit(start + finish)
  expect(await launch.result).toMatchObject({ commandId, exitCode: 130 })
  expect(launch.runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
})

it.each([1_000, 10_000])('coalesces %i legacy finishes into one owned check and still observes the latest return', async (count) => {
  vi.useFakeTimers()
  const launch = watch()
  vi.mocked(launch.runtime.readLaunchedAgentForeground).mockResolvedValue('shell')
  launch.emit('\x1b]133;C\x07' + '\x1b]133;D;1\x07'.repeat(count))
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(350)
  expect(await launch.result).toMatchObject({ message: "The agent's launch command exited before the agent was ready, without printing anything." })
  expect(vi.getTimerCount()).toBe(0)
  expect(launch.listeners.size).toBe(0)
})

it('retires the original wait immediately while the successor keeps the same terminal', async () => {
  const launch = watch()
  const successor = vi.fn()
  launch.listeners.add(successor)
  launch.emit(start)
  launch.emit(`${finish}\x1b]133;C\x07successor output`)
  expect(launch.signal()?.aborted).toBe(true)
  expect(await launch.result).toMatchObject({
    name: 'TerminalCommandFinishedError', commandId, exitCode: 130
  })
  launch.emit('still running')
  expect(successor).toHaveBeenLastCalledWith('still running')
  expect(launch.listeners.size).toBe(1)
  expect(launch.runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
})

it('accepts completed replay without a retained start and never begins dependent work', async () => {
  const launch = watch(`${finish}\x1b]133;C\x07successor`)
  expect(await launch.result).toMatchObject({ commandId, exitCode: 130 })
  expect(launch.wait).not.toHaveBeenCalled()
  expect(launch.listeners.size).toBe(0)
})

it('joins contiguous replay and live bytes when completion is split at attachment', async () => {
  const launch = watch(start + '\x1b]133;D;130;orca_command=0123456789abcdef')
  launch.emit('0123456789abcdef\x07\x1b]133;C\x07successor')
  expect(await launch.result).toMatchObject({ commandId, exitCode: 130 })
  expect(launch.signal()?.aborted).toBe(true)
  expect(launch.listeners.size).toBe(0)
})

it('does not use historical or nested metadata as this command’s finish', async () => {
  const launch = watch(finish, false)
  launch.emit(start)
  launch.emit('\x1b]133;C\x07\x1b]133;D;0\x07')
  launch.emit('\x1b]133;D;0;orca_command=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x07')
  expect(launch.signal()?.aborted).toBe(false)
  launch.emit(finish)
  expect(await launch.result).toMatchObject({ commandId, exitCode: 130 })
})

it('retires even when a legacy foreground read is still outstanding', async () => {
  vi.useFakeTimers()
  const launch = watch()
  let answer: (value: 'shell') => void = () => {}
  vi.mocked(launch.runtime.readLaunchedAgentForeground).mockImplementation(
    () => new Promise((resolve) => { answer = resolve })
  )
  launch.emit('\x1b]133;C\x07\x1b]133;D;1\x07')
  await vi.advanceTimersByTimeAsync(350)
  launch.emit(`${start}${finish}\x1b]133;C\x07successor`)
  expect(await launch.result).toMatchObject({ commandId, exitCode: 130 })
  answer('shell')
  await vi.runAllTimersAsync()
  expect(launch.listeners.size).toBe(0)
})
