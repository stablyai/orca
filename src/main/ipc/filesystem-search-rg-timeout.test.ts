import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, resolveAuthorizedPathMock, checkRgAvailableMock, wslAwareSpawnMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    resolveAuthorizedPathMock: vi.fn(),
    checkRgAvailableMock: vi.fn(),
    wslAwareSpawnMock: vi.fn()
  }))

const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown> | unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    trashItem: vi.fn()
  }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('../wsl', () => ({
  parseWslPath: vi.fn(() => null),
  toWindowsWslPath: vi.fn((value: string) => value)
}))

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: vi.fn(async (value: string) => value),
  isENOENT: vi.fn(() => false),
  resolveAuthorizedPath: resolveAuthorizedPathMock,
  resolveRegisteredWorktreePath: vi.fn(async (value: string) => value),
  validateGitRelativeFilePath: vi.fn((value: string) => value)
}))

vi.mock('./filesystem-list-files', () => ({
  listQuickOpenFiles: vi.fn()
}))

vi.mock('./filesystem-mutations', () => ({
  registerFilesystemMutationHandlers: vi.fn()
}))

vi.mock('./filesystem-search-git', () => ({
  searchWithGitGrep: vi.fn()
}))

vi.mock('./markdown-documents', () => ({
  listMarkdownDocuments: vi.fn(),
  markdownDocumentsFromRelativePaths: vi.fn()
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

import { registerFilesystemHandlers } from './filesystem'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  return p
}

describe('filesystem rg search timeout', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    resolveAuthorizedPathMock.mockImplementation(async (value: string) => value)
    checkRgAvailableMock.mockResolvedValue(true)
  })

  it('settles and detaches when rg ignores the timeout kill', async () => {
    vi.useFakeTimers()

    try {
      const child = createMockProcess()
      wslAwareSpawnMock.mockReturnValue(child)
      registerFilesystemHandlers({} as never)

      const promise = handlers.get('fs:search')!(
        { sender: { id: 7 } },
        { rootPath: '/repo', query: 'ok' }
      ) as Promise<{ truncated: boolean }>

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      await vi.runOnlyPendingTimersAsync()

      const result = await promise
      expect(result.truncated).toBe(true)
      expect(child.kill).toHaveBeenCalled()
      expect((child.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((child.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
