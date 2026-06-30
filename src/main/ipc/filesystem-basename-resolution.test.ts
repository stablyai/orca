import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitSpawnMock,
  wslAwareSpawnMock,
  resolveAuthorizedPathMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitSpawnMock: vi.fn(),
  wslAwareSpawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitSpawn: gitSpawnMock,
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('../wsl', () => ({
  parseWslPath: vi.fn(() => null),
  toWindowsWslPath: vi.fn((value: string) => value)
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

import { resolveQuickOpenFileByBasename } from './filesystem-basename-resolution'
import type { Store } from '../persistence'

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

describe('filesystem basename resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (pathValue) => pathValue)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    checkRgAvailableMock.mockResolvedValue(true)
  })

  it('uses a targeted git basename pathspec inside git worktrees', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'true\n', stderr: '' })
    const primary = createMockProcess()
    const ignored = createMockProcess()
    gitSpawnMock.mockImplementationOnce(() => primary).mockImplementationOnce(() => ignored)

    const promise = resolveQuickOpenFileByBasename('/repo', 'Foo.ts', {} as Store)

    setTimeout(() => {
      ;(primary.stdout as unknown as EventEmitter).emit('data', 'src/Foo.ts\0')
      primary.emit('close', 0, null)
      ignored.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toBe('src/Foo.ts')
    expect(gitSpawnMock.mock.calls[0][0]).toContain(':(glob)**/Foo.ts')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('uses an rg basename include glob outside git worktrees', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('not git'))
    const primary = createMockProcess()
    const ignored = createMockProcess()
    wslAwareSpawnMock.mockImplementationOnce(() => primary).mockImplementationOnce(() => ignored)

    const promise = resolveQuickOpenFileByBasename('/repo', 'Foo.ts', {} as Store)

    setTimeout(() => {
      ;(primary.stdout as unknown as EventEmitter).emit('data', './src/Foo.ts\n')
      primary.emit('close', 0, null)
      ignored.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toBe('src/Foo.ts')
    expect(wslAwareSpawnMock.mock.calls[0][1]).toContain('**/Foo.ts')
  })
})
