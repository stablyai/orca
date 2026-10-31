import { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>()
  return { ...original, spawn: spawnMock }
})

import { runProcess } from './run-process'
import { _setWindowsTaskkillLauncherForTests } from './windows-tree-kill'

class FakeProcess extends ChildProcess {
  override pid: number
  override kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

describe('runProcess barrier with a slow Windows taskkill', () => {
  const originalPlatform = process.platform
  let root: FakeProcess
  let taskkill: FakeProcess

  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    root = new FakeProcess(1234)
    taskkill = new FakeProcess(5678)
    spawnMock.mockReturnValue(root)
    _setWindowsTaskkillLauncherForTests(() => taskkill)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    _setWindowsTaskkillLauncherForTests(null)
    spawnMock.mockReset()
    vi.useRealTimers()
  })

  it('leaves the root to taskkill and settles as soon as a late taskkill succeeds', async () => {
    const onChildTerminated = vi.fn()
    const pending = runProcess({
      program: 'C:\\git.exe',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    // Exceed both the taskkill wait and root-exit grace.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(settled).toBe(false)
    expect(root.kill).not.toHaveBeenCalled()
    expect(taskkill.kill).not.toHaveBeenCalled()
    expect(onChildTerminated).not.toHaveBeenCalled()

    taskkill.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)

    await expect(pending).resolves.toMatchObject({ timedOut: true })
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('releases on root close, as before, while taskkill can still verify the barrier', async () => {
    const onChildTerminated = vi.fn()
    const pending = runProcess({
      program: 'C:\\git.exe',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated
    })

    await vi.advanceTimersByTimeAsync(1_000)
    // The root can exit before taskkill finishes its descendants.
    root.emit('exit', 1, null)
    root.emit('close', 1, null)
    // The admission budget follows root lifetime, independently of tree verification.
    expect(onChildTerminated).toHaveBeenCalledOnce()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(settled).toBe(false)

    taskkill.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await expect(pending).resolves.toMatchObject({ timedOut: true })
  })

  it('abandons taskkill shortly after the root exits so it cannot walk a reissued pid', async () => {
    const onChildTerminated = vi.fn()
    const pending = runProcess({
      program: 'C:\\git.exe',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated
    })

    await vi.advanceTimersByTimeAsync(1_000)
    root.emit('exit', 0, null)
    root.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(taskkill.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(taskkill.kill).toHaveBeenCalledOnce()
    expect(onChildTerminated).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toMatchObject({ timedOut: true })
  })

  it('releases on root close once an abandoned taskkill has killed the root', async () => {
    const onChildTerminated = vi.fn()
    void runProcess({
      program: 'C:\\git.exe',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated
    })

    await vi.advanceTimersByTimeAsync(30_010)
    expect(taskkill.kill).toHaveBeenCalledOnce()
    expect(root.kill).toHaveBeenCalledWith(undefined)
    expect(onChildTerminated).not.toHaveBeenCalled()

    root.emit('close', null, 'SIGKILL')
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })
})
