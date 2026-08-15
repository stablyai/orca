import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  resolveAuthorizedPathMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  searchWithGitGrepMock,
  wslAwareSpawnMock,
  toWindowsWslPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  searchWithGitGrepMock: vi.fn(),
  wslAwareSpawnMock: vi.fn(),
  toWindowsWslPathMock: vi.fn((value: string) => value)
}))

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

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
  toWindowsWslPath: toWindowsWslPathMock
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
  searchWithGitGrep: searchWithGitGrepMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
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
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
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
      expect(checkRgAvailableMock).not.toHaveBeenCalled()
      expect(child.kill).toHaveBeenCalled()
      expect((child.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((child.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['error-first', 'close-first'] as const)(
    'falls back once when a native launch failure is %s',
    async (order) => {
      const child = createMockProcess()
      Object.defineProperty(child, 'pid', { value: undefined })
      wslAwareSpawnMock.mockReturnValue(child)
      const fallback = { files: [], totalMatches: 0, truncated: false }
      searchWithGitGrepMock.mockResolvedValue(fallback)
      registerFilesystemHandlers({} as never)

      const promise = handlers.get('fs:search')!(
        { sender: { id: 7 } },
        { rootPath: '/repo', query: 'ok' }
      ) as Promise<unknown>
      await flushMicrotasks()
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
      if (order === 'error-first') {
        expect(() => child.emit('error', error)).not.toThrow()
        child.emit('close', -2, null)
      } else {
        child.emit('close', -2, null)
        expect(() => child.emit('error', error)).not.toThrow()
      }

      await expect(promise).resolves.toBe(fallback)
      expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)
      expect(checkRgAvailableMock).not.toHaveBeenCalled()
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    }
  )

  it('keeps post-spawn errors on the existing empty-result path', async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    wslAwareSpawnMock.mockReturnValue(child)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: '/repo', query: 'ok' }
    ) as Promise<{ files: unknown[] }>
    await flushMicrotasks()
    child.emit('error', new Error('post-spawn failure'))

    await expect(promise).resolves.toMatchObject({ files: [] })
    expect(searchWithGitGrepMock).not.toHaveBeenCalled()
  })

  it("falls back when a native launcher exits outside ripgrep's contract", async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    wslAwareSpawnMock.mockReturnValue(child)
    const fallback = { files: [], totalMatches: 0, truncated: false }
    searchWithGitGrepMock.mockResolvedValue(fallback)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: '/repo', query: 'ok' }
    ) as Promise<unknown>
    await flushMicrotasks()
    child.emit('close', 127, null)

    await expect(promise).resolves.toBe(fallback)
    expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)
  })

  it('routes rg through the registered WSL project runtime for Windows-path worktrees', async () => {
    const child = createMockProcess()
    Object.defineProperty(child, 'pid', { value: 1 })
    wslAwareSpawnMock.mockReturnValue(child)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: 'C:\\repo', query: 'ok' }
    ) as Promise<unknown>

    setTimeout(() => {
      child.emit('close', 127, null)
    }, 10)

    await promise

    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(searchWithGitGrepMock).not.toHaveBeenCalled()
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      'rg',
      expect.any(Array),
      expect.objectContaining({
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      })
    )
  })

  it('keeps the WSL search preflight and falls back before starting real rg', async () => {
    const fallback = { files: [], totalMatches: 0, truncated: false }
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    checkRgAvailableMock.mockResolvedValue(false)
    searchWithGitGrepMock.mockResolvedValue(fallback)
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: 'C:\\repo', query: 'ok' }
    ) as Promise<unknown>

    await expect(promise).resolves.toBe(fallback)
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('translates WSL rg output for Windows-path project search results', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    toWindowsWslPathMock.mockImplementation((value: string) =>
      value.replace('/mnt/c/repo', 'C:\\repo').replace(/\//g, '\\')
    )
    registerFilesystemHandlers({} as never)

    const promise = handlers.get('fs:search')!(
      { sender: { id: 7 } },
      { rootPath: 'C:\\repo', query: 'hello' }
    ) as Promise<{
      files: { filePath: string; relativePath: string; matchCount: number }[]
    }>

    setTimeout(() => {
      if (!child.stdout) {
        throw new Error('mock child stdout missing')
      }
      child.stdout.emit(
        'data',
        `${JSON.stringify({
          type: 'match',
          data: {
            path: { text: '/mnt/c/repo/src/index.ts' },
            lines: { text: 'hello world\n' },
            line_number: 3,
            submatches: [{ start: 0, end: 5 }]
          }
        })}\n`
      )
      child.emit('close')
    }, 10)

    const result = await promise

    expect(result.files).toEqual([
      expect.objectContaining({
        filePath: 'C:\\repo\\src\\index.ts',
        relativePath: 'src/index.ts',
        matchCount: 1
      })
    ])
    expect(toWindowsWslPathMock).toHaveBeenCalledWith('/mnt/c/repo/src/index.ts', 'Ubuntu')
  })
})
