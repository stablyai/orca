import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const { spawnMock, handleMock, resolveAuthorizedPathMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  handleMock: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
    handlers.set(channel, handler)
  }),
  resolveAuthorizedPathMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

import { registerNotebookHandlers } from './notebook'

function createMockProcess(pid = 1234): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(proc, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    unref: vi.fn()
  })
  return proc
}

describe('notebook IPC', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    handlers.clear()
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockResolvedValue('/repo/notebook.ipynb')
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    processKillSpy.mockRestore()
    vi.useRealTimers()
  })

  it('kills the Python process group when a cell times out', async () => {
    const proc = createMockProcess(4321)
    const killerProc = createMockProcess(4322)
    spawnMock.mockReturnValueOnce(proc).mockReturnValue(killerProc)
    registerNotebookHandlers({} as never)

    const handler = handlers.get('notebook:runPythonCell')
    expect(handler).toBeDefined()
    const resultPromise = handler?.(null, {
      filePath: '/repo/notebook.ipynb',
      code: 'while True: pass'
    }) as Promise<unknown>

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      error: 'Python cell timed out.'
    })
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stderr.listenerCount('data')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('close')).toBe(0)

    if (process.platform !== 'win32') {
      expect(spawnMock).toHaveBeenCalledWith(
        'python3',
        expect.any(Array),
        expect.objectContaining({ detached: true })
      )
      expect(processKillSpy).toHaveBeenCalledWith(-4321, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      expect(processKillSpy).toHaveBeenCalledWith(-4321, 'SIGKILL')
    }
  })
})
