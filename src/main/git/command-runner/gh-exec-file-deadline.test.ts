import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, processKillMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  processKillMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

import { ghExecFileAsync } from './gh-exec-file'

function mockChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

function settleChild(child: ChildProcess, stdout: string): void {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

/**
 * The contract the star check depends on after #18234: a `gh` that never exits
 * is killed at the deadline, and the kill reaches the whole chain. On the
 * reporter's box `gh` was a shell wrapper calling `mise x gh`, so signalling
 * only the direct child left the rest of the chain running under init.
 */
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
      // Why never emitting exit: this is exactly the stuck child from #18234 —
      // spawned, spinning, and never reporting an exit.
      spawnMock.mockReturnValue(child)

      const pending = ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
        timeout: 15_000
      })
      const rejection = expect(pending).rejects.toThrow('timed out')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

      // The child must be its own group leader, or the signal below would go to
      // whatever group it inherited — Orca's own.
      expect(spawnMock.mock.calls[0][2].detached).toBe(true)
      expect(processKillMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await rejection

      expect(processKillMock).toHaveBeenCalledWith(-4321, undefined)
    }
  )

  it('spawns with hidden console and captured stdio, never an inherited or shell stdio', async () => {
    const child = mockChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(child, 'HTTP/2.0 204 No Content\r\n'))
      return child
    })

    const result = await ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
      timeout: 15_000
    })

    expect(result.stdout).toContain('204 No Content')
    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe('gh')
    expect(args).toEqual(['api', '--include', 'user/starred/stablyai/orca'])
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.shell).toBe(false)
  })

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
