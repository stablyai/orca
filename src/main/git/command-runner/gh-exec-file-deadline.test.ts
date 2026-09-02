import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock, killSpawnedCommandTreeMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))
vi.mock('./spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killSpawnedCommandTreeMock
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

/**
 * The contract the star check depends on after #18234: a `gh` that never exits
 * is killed at the deadline, tree and all, rather than running forever.
 */
describe('gh exec deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    spawnMock.mockReset()
    killSpawnedCommandTreeMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills the process tree and rejects when gh never exits', async () => {
    const child = mockChild()
    // Why never invoking the callback: this is exactly the stuck child from
    // #18234 — spawned, spinning, and never reporting an exit.
    execFileMock.mockReturnValue(child)

    const pending = ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
      timeout: 15_000
    })
    const rejection = expect(pending).rejects.toThrow('timed out')
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())

    // Not yet: the deadline has not elapsed.
    expect(killSpawnedCommandTreeMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    await rejection

    expect(killSpawnedCommandTreeMock).toHaveBeenCalledWith(child)
  })

  it('spawns with hidden console and captured stdio, never an inherited or shell stdio', async () => {
    const child = mockChild()
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, 'HTTP/2.0 204 No Content\r\n', '')
        return child
      }
    )

    await ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })

    const [command, args, options] = execFileMock.mock.calls[0]
    expect(command).toBe('gh')
    expect(args).toEqual(['api', '--include', 'user/starred/stablyai/orca'])
    // `execFile` captures stdout/stderr over pipes and never inherits Orca's;
    // `shell` is never set, and the console stays hidden on Windows.
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toBeUndefined()
    expect(options.shell).toBeUndefined()
  })
})
