import { ChildProcess } from 'node:child_process'
import type * as Os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPriorityMock, setPriorityMock } = vi.hoisted(() => ({
  getPriorityMock: vi.fn(),
  setPriorityMock: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  getPriority: getPriorityMock,
  setPriority: setPriorityMock
}))
import {
  _setWindowsTaskkillLauncherForTests,
  inFlightWindowsTreeKill,
  startWindowsTreeKill,
  trackedWindowsTreeKill,
  waitForWindowsTreeKill,
  WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS,
  WINDOWS_TASKKILL_DEADLINE_MS,
  WINDOWS_TASKKILL_WAIT_MS
} from './windows-tree-kill'

class FakeProcess extends ChildProcess {
  override kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
}

describe('windows tree kill tracker', () => {
  const launched: FakeProcess[] = []
  const launch = vi.fn((_rootPid: number) => {
    const taskkill = new FakeProcess()
    launched.push(taskkill)
    return taskkill
  })

  beforeEach(() => {
    vi.useFakeTimers()
    launched.length = 0
    launch.mockClear()
    _setWindowsTaskkillLauncherForTests(launch)
  })

  afterEach(() => {
    _setWindowsTaskkillLauncherForTests(null)
    vi.useRealTimers()
  })

  it('reports exited only once taskkill succeeds', async () => {
    const child = new FakeProcess()
    const killRoot = vi.fn()
    const kill = startWindowsTreeKill(child, 1234, killRoot)

    expect(launch).toHaveBeenCalledWith(1234)
    expect(kill.verdict()).toBe('live')
    launched[0].emit('close', 0)

    await expect(kill.settled).resolves.toBe('exited')
    expect(kill.verdict()).toBe('exited')
    expect(killRoot).not.toHaveBeenCalled()
  })

  it('keeps one taskkill running past the wait and lets later requests join it', async () => {
    const child = new FakeProcess()
    const killRoot = vi.fn()
    const first = startWindowsTreeKill(child, 1234, killRoot)
    const waited = waitForWindowsTreeKill(first)

    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_WAIT_MS)
    await expect(waited).resolves.toBe(false)
    expect(first.verdict()).toBe('live')
    expect(inFlightWindowsTreeKill(child)).toBe(first.settled)
    expect(launched[0].kill).not.toHaveBeenCalled()
    expect(killRoot).not.toHaveBeenCalled()

    const joined = startWindowsTreeKill(child, 1234, vi.fn())
    expect(joined).toBe(first)
    expect(launch).toHaveBeenCalledOnce()

    const secondWait = waitForWindowsTreeKill(joined)
    launched[0].emit('close', 0)
    await expect(secondWait).resolves.toBe(true)
    expect(inFlightWindowsTreeKill(child)).toBeUndefined()
    expect(startWindowsTreeKill(child, 1234, vi.fn())).toBe(first)
    expect(launch).toHaveBeenCalledOnce()
  })

  it.each([
    ['a failed taskkill', (taskkill: FakeProcess) => taskkill.emit('close', 128)],
    [
      'a taskkill that cannot start',
      (taskkill: FakeProcess) => taskkill.emit('error', new Error('spawn EPERM'))
    ]
  ])('reports %s as unverifiable, kills the root, and allows a retry', async (_name, fail) => {
    const child = new FakeProcess()
    const killRoot = vi.fn()
    const kill = startWindowsTreeKill(child, 1234, killRoot)

    fail(launched[0])

    await expect(kill.settled).resolves.toBe('unverifiable')
    expect(killRoot).toHaveBeenCalledOnce()
    expect(trackedWindowsTreeKill(child)).toBeUndefined()
    const retry = startWindowsTreeKill(child, 1234, vi.fn())
    expect(retry).not.toBe(kill)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('reports a launch that throws as unverifiable', async () => {
    launch.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const killRoot = vi.fn()
    const kill = startWindowsTreeKill(new FakeProcess(), 1234, killRoot)

    await expect(kill.settled).resolves.toBe('unverifiable')
    await expect(waitForWindowsTreeKill(kill)).resolves.toBe(false)
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('abandons a wedged taskkill at the deadline, then kills the root', async () => {
    const child = new FakeProcess()
    const killRoot = vi.fn()
    const kill = startWindowsTreeKill(child, 1234, killRoot)

    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_DEADLINE_MS - 1)
    expect(kill.verdict()).toBe('live')
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(kill.settled).resolves.toBe('unverifiable')
    expect(launched[0].kill).toHaveBeenCalledOnce()
    expect(killRoot).toHaveBeenCalledOnce()
    launched[0].emit('close', 0)
    expect(kill.verdict()).toBe('unverifiable')
  })

  it('still proves a tree when taskkill finishes soon after killing the root', async () => {
    const child = new FakeProcess()
    const kill = startWindowsTreeKill(child, 1234, vi.fn())

    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS - 1)
    launched[0].emit('close', 0)

    await expect(kill.settled).resolves.toBe('exited')
  })

  it('abandons taskkill once the root has been gone long enough for its pid to be reissued', async () => {
    const child = new FakeProcess()
    const kill = startWindowsTreeKill(child, 1234, vi.fn())

    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_AFTER_ROOT_EXIT_MS)

    await expect(kill.settled).resolves.toBe('unverifiable')
    expect(launched[0].kill).toHaveBeenCalledOnce()
  })

  it('never joins two children that share a reused pid', () => {
    startWindowsTreeKill(new FakeProcess(), 1234, vi.fn())
    startWindowsTreeKill(new FakeProcess(), 1234, vi.fn())

    expect(launch).toHaveBeenCalledTimes(2)
  })

  describe('termination helper scheduling', () => {
    const originalPlatform = process.platform

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      getPriorityMock.mockReset().mockReturnValue(10)
      setPriorityMock.mockReset()
      launch.mockImplementationOnce(() => {
        const killer = new FakeProcess()
        Object.defineProperty(killer, 'pid', { value: 5678 })
        launched.push(killer)
        return killer
      })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    })

    it.each([10, 19])('restores normal priority for a background helper at %i', (priority) => {
      getPriorityMock.mockReturnValue(priority)
      const killRoot = vi.fn()
      const kill = startWindowsTreeKill(new FakeProcess(), 1234, killRoot)

      expect(setPriorityMock).toHaveBeenCalledWith(5678, 0)
      expect(kill.verdict()).toBe('live')
      expect(killRoot).not.toHaveBeenCalled()
      launched[0].emit('close', 0)
      expect(kill.verdict()).toBe('exited')
    })

    it.each([0, -7, -14])('preserves a helper already at priority %i', (priority) => {
      getPriorityMock.mockReturnValue(priority)
      startWindowsTreeKill(new FakeProcess(), 1234, vi.fn())

      expect(setPriorityMock).not.toHaveBeenCalled()
      launched[0].emit('close', 0)
    })

    it.each(['read', 'write'])('keeps tracking when the priority %s fails', async (operation) => {
      const fail = (): never => {
        throw new Error('priority access denied or helper already exited')
      }
      if (operation === 'read') {
        getPriorityMock.mockImplementation(fail)
      } else {
        setPriorityMock.mockImplementation(fail)
      }
      const killRoot = vi.fn()
      const kill = startWindowsTreeKill(new FakeProcess(), 1234, killRoot)

      await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_WAIT_MS)
      expect(kill.verdict()).toBe('live')
      expect(killRoot).not.toHaveBeenCalled()
      launched[0].emit('close', 0)
      await expect(kill.settled).resolves.toBe('exited')
    })

    it('leaves POSIX scheduling unchanged', () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      startWindowsTreeKill(new FakeProcess(), 1234, vi.fn())

      expect(getPriorityMock).not.toHaveBeenCalled()
      expect(setPriorityMock).not.toHaveBeenCalled()
      launched[0].emit('close', 0)
    })
  })
})
