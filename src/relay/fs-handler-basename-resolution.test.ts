import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execFileMock, checkRgAvailableMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  checkRgAvailableMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock
}))

vi.mock('./fs-handler-utils', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

import { resolveUniqueQuickOpenFileByBasename } from './fs-handler-basename-resolution'

function createMockProcess(): ChildProcess {
  const process = new EventEmitter() as unknown as ChildProcess
  ;(process as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (process as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(process as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(process as unknown as Record<string, unknown>).kill = vi.fn()
  ;(process as unknown as Record<string, unknown>).exitCode = null
  ;(process as unknown as Record<string, unknown>).signalCode = null
  return process
}

describe('relay basename resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkRgAvailableMock.mockResolvedValue(true)
  })

  it('uses a targeted git basename pathspec inside git worktrees', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void
      ) => {
        callback(null, 'true\n')
      }
    )
    const primary = createMockProcess()
    const ignored = createMockProcess()
    spawnMock.mockImplementationOnce(() => primary).mockImplementationOnce(() => ignored)

    const promise = resolveUniqueQuickOpenFileByBasename('/remote/repo', 'Foo.ts')

    setTimeout(() => {
      ;(primary.stdout as unknown as EventEmitter).emit('data', 'src/Foo.ts\0')
      primary.emit('close', 0, null)
      ignored.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toBe('src/Foo.ts')
    expect(spawnMock.mock.calls[0][0]).toBe('git')
    expect(spawnMock.mock.calls[0][1]).toContain(':(glob)**/Foo.ts')
  })

  it('uses an rg basename include glob outside git worktrees', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void
      ) => {
        callback(new Error('not git'), '')
      }
    )
    const primary = createMockProcess()
    const ignored = createMockProcess()
    spawnMock.mockImplementationOnce(() => primary).mockImplementationOnce(() => ignored)

    const promise = resolveUniqueQuickOpenFileByBasename('/remote/repo', 'Foo.ts')

    setTimeout(() => {
      ;(primary.stdout as unknown as EventEmitter).emit('data', './src/Foo.ts\n')
      primary.emit('close', 0, null)
      ignored.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toBe('src/Foo.ts')
    expect(spawnMock.mock.calls[0][0]).toBe('rg')
    expect(spawnMock.mock.calls[0][1]).toContain('**/Foo.ts')
  })
})
