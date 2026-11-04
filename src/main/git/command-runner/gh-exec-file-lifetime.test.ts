import type { ChildProcess } from 'node:child_process'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, signalMock, forceMock, resolveSelectedMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn(),
  resolveSelectedMock: vi.fn((command: string) => command)
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../../ipc/command-path/command-path-resolver', () => ({
  resolveSelectedLocalCommand: resolveSelectedMock
}))

import { ghExecFileAsync } from './gh-exec-file'
import { createGhLogicalLifetime } from './gh-capture-lifetime'

function child(pid?: number): ChildProcess {
  const value = createFakeSpawnedChild()
  Object.defineProperty(value, 'pid', { value: pid })
  value.kill = vi.fn(() => false)
  return value
}
function finish(value: ChildProcess, code = 0, stdout = '', stderr = ''): void {
  value.stdout?.emit('data', Buffer.from(stdout))
  value.stderr?.emit('data', Buffer.from(stderr))
  value.emit('exit', code, null)
  value.emit('close', code, null)
}

describe('tracked gh capture lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    signalMock.mockResolvedValue(false)
    forceMock.mockResolvedValue(false)
    resolveSelectedMock.mockReset().mockImplementation((command: string) => command)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([false, true])(
    'keeps grace settlement separate from termination (abort: %s)',
    async (abort) => {
      const value = child(1234)
      spawnMock.mockReturnValue(value)
      const owner = createGhLogicalLifetime()
      const controller = new AbortController()
      const result = ghExecFileAsync(
        ['api', 'user'],
        { timeout: 10, ...(abort ? { signal: controller.signal } : {}) },
        owner.hooks
      )
      const rejection = expect(result).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      if (abort) {
        controller.abort('private-reason')
      }
      await vi.advanceTimersByTimeAsync(12_010)
      await rejection
      owner.seal()
      let terminated = false
      void owner.terminated.then(() => {
        terminated = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(terminated).toBe(false)
      expect(spawnMock).toHaveBeenCalledOnce()
      value.emit('close', null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(0)
      expect(terminated).toBe(true)
    }
  )

  it('waits for a PID error close before retry and ignores its stale callback', async () => {
    const values = [child(11), child(12)]
    spawnMock.mockReturnValueOnce(values[0]).mockReturnValueOnce(values[1])
    const owner = createGhLogicalLifetime()
    const controller = new AbortController()
    const result = ghExecFileAsync(['api', 'user'], { signal: controller.signal }, owner.hooks)
    await vi.advanceTimersByTimeAsync(0)
    values[0].emit(
      'error',
      Object.assign(new Error('failed'), { stderr: 'HTTP 503 Service Unavailable' })
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(spawnMock).toHaveBeenCalledOnce()
    values[0].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    values[0].emit('close', 1, null)
    owner.seal()
    let terminated = false
    void owner.terminated.then(() => {
      terminated = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(terminated).toBe(false)
    finish(values[1], 0, 'ok')
    await expect(result).resolves.toMatchObject({ stdout: 'ok' })
    await owner.terminated
  })
})
