// The roster slot on the real gh runner: spawn and process-tree termination are faked, nothing else.
import type { ChildProcess } from 'node:child_process'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { groupExists, spawnMock, signalMock, forceMock } = vi.hoisted(() => ({
  groupExists: vi.fn(() => true),
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  processGroupExists: groupExists,
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../ipc/command-path/command-path-resolver', () => ({
  resolveSelectedLocalCommand: (command: string) => command
}))

import { GitHubPeopleRosters, ROSTER_TIMEOUT_MS } from './github-people-roster'

function child(pid: number): ChildProcess {
  const value = createFakeSpawnedChild()
  // 0: a process that never existed (no pid), as when the spawn itself fails.
  Object.defineProperty(value, 'pid', { value: pid || undefined })
  value.kill = vi.fn(() => false)
  return value
}
function close(value: ChildProcess, code = 0, stdout = ''): void {
  value.stdout?.emit('data', Buffer.from(stdout))
  value.emit('exit', code, null)
  groupExists.mockReturnValue(false)
  value.emit('close', code, null)
}
const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })

describe('the one roster read per app run, on the real gh runner', () => {
  beforeEach(() => {
    groupExists.mockReturnValue(true)
    vi.useFakeTimers()
    spawnMock.mockReset()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills a slow read at the deadline and never starts another child, whatever its end', async () => {
    const first = child(11)
    spawnMock.mockReturnValueOnce(first)
    const rosters = new GitHubPeopleRosters()
    const slow = rosters.read(repos('a/b'), 'owner')
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(ROSTER_TIMEOUT_MS)
    expect(signalMock).toHaveBeenCalled()
    // The group is still reported alive: the caller gets its answer anyway...
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(await slow).toEqual({ status: 'unavailable' })
    // ...and no later request, for any scope, starts a second child, before or after it closes.
    expect(await rosters.read(repos('c/d'), 'owner')).toEqual({ status: 'unavailable' })
    close(first, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await rosters.read(repos('e/f'), 'owner')).toEqual({ status: 'unavailable' })
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('keeps the latch when gh could not be started either: no failure proves no process existed', async () => {
    // gh missing: every attempt (the runner may try another gh binary) fails to spawn.
    const spawnFails = (): ChildProcess => {
      const failed = child(0)
      queueMicrotask(() =>
        failed.emit(
          'error',
          Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', syscall: 'spawn gh' })
        )
      )
      return failed
    }
    spawnMock.mockImplementation(spawnFails)
    const rosters = new GitHubPeopleRosters()
    const failed = rosters.read(repos('a/b'), 'owner')
    await vi.advanceTimersByTimeAsync(0)
    expect(await failed).toEqual({ status: 'unavailable' })
    const attempts = spawnMock.mock.calls.length
    expect(await rosters.read(repos('a/b'), 'owner')).toEqual({ status: 'unavailable' })
    expect(spawnMock).toHaveBeenCalledTimes(attempts)
  })
})
