import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import type * as NodeChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, admitMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  admitMock: vi.fn(() => true)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  spawn: spawnMock
}))
vi.mock('../../../pty/process-retirement/own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: admitMock
}))

import { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'
import { killAbandonedWorkerChildTree, killSpawnedCommandTree } from './spawned-command-tree-kill'

const originalPlatform = process.platform

function childWithPid(pid: number): ChildProcess {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: pid })
  vi.spyOn(child, 'kill').mockReturnValue(true)
  vi.spyOn(child, 'unref').mockImplementation(() => {})
  return child
}

describe('Git command tree termination', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    spawnMock.mockReset()
    admitMock.mockReset().mockReturnValue(true)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.restoreAllMocks()
  })

  it.each([0, 128])(
    'never taskkills a child that exited with code %i before close',
    async (code) => {
      const child = childWithPid(1234)
      Object.defineProperty(child, 'exitCode', { value: code })

      await killSpawnedCommandTree(child)

      expect(spawnMock).not.toHaveBeenCalled()
      expect(admitMock).not.toHaveBeenCalled()
      expect(child.kill).toHaveBeenCalledOnce()
    }
  )

  it('never taskkills a child that exited by signal before close', async () => {
    const child = childWithPid(1234)
    Object.defineProperty(child, 'signalCode', { value: 'SIGTERM' })

    await killSpawnedCommandTree(child)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(admitMock).not.toHaveBeenCalled()
  })

  it('still waits for tree termination when the Windows root has not exited', async () => {
    const child = childWithPid(1234)
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    let settled = false
    const pending = killSpawnedCommandTree(child).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.emit('close', 0)
    await pending
    expect(child.kill).not.toHaveBeenCalled()
  })
  it('kills the whole tree of a worker child cancelled before its PID arrived', async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    const rootKill = vi.spyOn(child, 'kill')
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    const pending = killSpawnedCommandTree(child)

    child.receive({ type: 'spawn', id: 1, pid: 4321 })
    await Promise.resolve()
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.emit('close', 0)
    await pending
    expect(rootKill).not.toHaveBeenCalled()
  })
  it('does not taskkill a worker child again when the worker dies during its tree kill', async () => {
    const child = new WorkerThreadChildProcess(1, () => true)
    child.receive({ type: 'spawn', id: 1, pid: 4321 })
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    const cancel = killSpawnedCommandTree(child)
    const abandoned = killAbandonedWorkerChildTree(child)

    killer.emit('close', 0)
    await Promise.all([cancel, abandoned])
    expect(spawnMock).toHaveBeenCalledOnce()
  })
  it('ends every tree a dying worker abandons with one taskkill', async () => {
    const children = [4321, 4322].map((pid, index) => {
      const child = new WorkerThreadChildProcess(index + 1, () => true)
      child.receive({ type: 'spawn', id: index + 1, pid })
      return child
    })
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    const abandoned = Promise.all(children.map((child) => killAbandonedWorkerChildTree(child)))

    await Promise.resolve()
    killer.emit('close', 0)
    await abandoned
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/pid', '4322', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true }
    )
  })
  it('still kills the tree when the worker reports the PID after the wait', async () => {
    vi.useFakeTimers()
    try {
      const child = new WorkerThreadChildProcess(1, () => true)
      vi.spyOn(child, 'kill').mockReturnValue(true)
      spawnMock.mockReturnValue(childWithPid(5678))
      const pending = killSpawnedCommandTree(child)
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
      expect(spawnMock).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()

      child.receive({ type: 'spawn', id: 1, pid: 4321 })
      expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      let released = false
      const abandoned = killAbandonedWorkerChildTree(child).then(() => {
        released = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(false)
      expect(spawnMock).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(2_000)
      await abandoned
    } finally {
      vi.useRealTimers()
    }
  })
  it.skipIf(originalPlatform !== 'win32').each([0, 128])(
    'does not taskkill an actual native Windows child after exit %i',
    async (exitCode) => {
      const original = await vi.importActual<typeof NodeChildProcess>('node:child_process')
      spawnMock.mockImplementation((program, args, options) => {
        if (program !== process.execPath) {
          throw new Error('Unexpected external process in native exit probe')
        }
        return original.spawn(program, args, options)
      })
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', `process.exit(${exitCode})`]
      })
      const closed = once(child, 'close')
      await once(child, 'exit')
      expect(child.exitCode).toBe(exitCode)
      expect(child.pid).toBeGreaterThan(0)
      spawnMock.mockClear()
      await killSpawnedCommandTree(child)
      expect(spawnMock).not.toHaveBeenCalled()
      expect(admitMock).not.toHaveBeenCalled()
      await closed
    }
  )
})
