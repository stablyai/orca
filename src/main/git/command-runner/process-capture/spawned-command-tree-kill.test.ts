import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import type * as NodeChildProcess from 'node:child_process'
import type * as WorkerChildModule from '../../../worker-thread-child-process/worker-thread-child-process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, admitMock, workerTaskkill } = vi.hoisted(() => {
  const workerTaskkill: {
    available: boolean
    killers: WorkerChildModule.WorkerThreadChildProcess[]
  } = { available: false, killers: [] }
  return { spawnMock: vi.fn(), admitMock: vi.fn(() => true), workerTaskkill }
})

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  spawn: spawnMock
}))
// Most cases drive main's native taskkill fake; worker-hosted ones turn the worker on.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WorkerChildModule>()
    return {
      ...actual,
      canSpawnOnWorkerThread: () => workerTaskkill.available,
      spawnProcessOnWorkerThread: () => {
        const killer = new actual.WorkerThreadChildProcess(99, () => true)
        workerTaskkill.killers.push(killer)
        return killer
      }
    }
  }
)
vi.mock('../../../pty/process-retirement/own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: admitMock
}))

import {
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'
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
    workerTaskkill.available = false
    workerTaskkill.killers = []
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
    expect(spawnMock).toHaveBeenCalledWith(
      windowsSystem32Binary('taskkill.exe'),
      ['/pid', '1234', '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true
      }
    )
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
    expect(spawnMock).toHaveBeenCalledWith(
      windowsSystem32Binary('taskkill.exe'),
      ['/pid', '4321', '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true
      }
    )
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
      windowsSystem32Binary('taskkill.exe'),
      ['/pid', '4321', '/pid', '4322', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true }
    )
  })
  it('awaits a taskkill queued on a live worker, with no main rerun, and starts its wait once it exists', async () => {
    vi.useFakeTimers()
    try {
      workerTaskkill.available = true
      const child = childWithPid(1234)
      const rootKill = vi.spyOn(child, 'kill').mockReturnValue(true)
      const pending = killSpawnedCommandTree(child)
      const killer = workerTaskkill.killers[0]!
      const stopKiller = vi.spyOn(killer, 'kill')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(stopKiller).not.toHaveBeenCalled()
      expect(rootKill).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()

      killer.receive({ type: 'spawn', id: 99, pid: 777 })
      await vi.advanceTimersByTimeAsync(2_000)
      await pending
      expect(stopKiller).toHaveBeenCalledOnce()
      expect(rootKill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not rerun a taskkill the worker already started when the worker dies', async () => {
    workerTaskkill.available = true
    const child = childWithPid(1234)
    const rootKill = vi.spyOn(child, 'kill').mockReturnValue(true)
    const pending = killSpawnedCommandTree(child)
    const killer = workerTaskkill.killers[0]!
    killer.receive({ type: 'spawn', id: 99, pid: 777 })
    killer.receive({
      type: 'error',
      id: 99,
      error: {
        message: 'Child process worker exited with code 1',
        code: WORKER_CHILD_ABANDONED_CODE
      }
    })
    await pending
    expect(spawnMock).not.toHaveBeenCalled()
    expect(rootKill).toHaveBeenCalledOnce()
  })
  it('reruns every taskkill a dying worker never started with one launch from main', async () => {
    workerTaskkill.available = true
    const children = [1234, 1235].map((pid) => childWithPid(pid))
    const pending = Promise.all(children.map((child) => killSpawnedCommandTree(child)))
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    for (const queued of workerTaskkill.killers) {
      queued.receive({
        type: 'error',
        id: 99,
        error: {
          message: 'Child process worker exited with code 1',
          code: WORKER_CHILD_ABANDONED_CODE
        }
      })
    }
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    expect(spawnMock).toHaveBeenCalledWith(
      windowsSystem32Binary('taskkill.exe'),
      ['/pid', '1234', '/pid', '1235', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true }
    )
    killer.emit('close', 0)
    await pending
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
      expect(spawnMock).toHaveBeenCalledWith(
        windowsSystem32Binary('taskkill.exe'),
        ['/pid', '4321', '/t', '/f'],
        {
          stdio: 'ignore',
          windowsHide: true
        }
      )
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
