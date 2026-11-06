import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'

const { spawnMock, processKillMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  processKillMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

import { ghExecFileAsync } from './gh-exec-file'

function mockChild(pid = 4321) {
  const child = createFakeSpawnedChild(pid)
  vi.spyOn(child.stdin, 'end')
  return child
}

function settleChild(child: ChildProcess, stdout: string): void {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

// gh may be a shim chain; the deadline must kill descendants as well as the wrapper.
describe('gh exec deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    processKillMock.mockReset()
    vi.spyOn(process, 'kill').mockImplementation(processKillMock as unknown as typeof process.kill)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.runIf(process.platform !== 'win32')(
    'signals the whole process group, not just the child, when gh never exits',
    async () => {
      const child = mockChild()
      spawnMock.mockReturnValue(child)

      const pending = ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
        timeout: 15_000
      })
      const rejection = expect(pending).rejects.toThrow('timed out')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

      // A detached group keeps cleanup signals from reaching Orca's own process group.
      expect(spawnMock.mock.calls[0][2].detached).toBe(true)
      expect(processKillMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await rejection

      expect(processKillMock).toHaveBeenCalledWith(-4321, undefined)
    }
  )

  it('fails rather than returning a clipped answer when gh overruns maxBuffer', async () => {
    const child = mockChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(child, '['.padEnd(64, 'x')))
      return child
    })

    await expect(
      ghExecFileAsync(['api', 'repos/stablyai/orca/issues'], { timeout: 15_000, maxBuffer: 8 })
    ).rejects.toThrow('more than 8 bytes')
  })
})
