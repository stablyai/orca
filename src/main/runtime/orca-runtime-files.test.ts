import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'fs'
import type * as FsPromises from 'fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'

const { resolveAuthorizedPathMock, statMock, watchMock } = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    stat: statMock
  }
})

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import { RuntimeFileCommands } from './orca-runtime-files'

describe('RuntimeFileCommands', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchMock.mockReset()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
  })

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const store = { getRepo: vi.fn(() => undefined) }
    const close = vi.fn()
    const on = vi.fn()
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return { close, on }
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })

    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveWorktreeSelector: vi.fn(async () => ({
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\repo'
      })),
      resolveRuntimeGitTarget: vi.fn(),
      openFile: vi.fn()
    } as never)
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    const emit = listener as (() => void) | null
    expect(emit).not.toBeNull()

    emit?.()
    emit?.()
    await vi.advanceTimersByTimeAsync(149)
    expect(onEvents).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    unsubscribe()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
