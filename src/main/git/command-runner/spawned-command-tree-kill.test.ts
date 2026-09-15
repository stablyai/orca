import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '../../../shared/child-process/run-process'
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

vi.mock('../../own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: admitMock
}))

import { killSpawnedCommandTree } from './spawned-command-tree-kill'

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

  it('preserves handle termination on POSIX', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const child = childWithPid(1234)

    await killSpawnedCommandTree(child)

    expect(child.kill).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
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
