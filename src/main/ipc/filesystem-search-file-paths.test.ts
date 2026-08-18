import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as GitRunner from '../git/runner'
import { isFileListingCancellation } from '../../shared/file-listing-cancellation'

const {
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  resolveAuthorizedPathMock,
  wslAwareSpawnMock
} = vi.hoisted(() => ({
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'

function createMockProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  ;(child as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (child as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(child as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).kill = vi.fn()
  ;(child as unknown as Record<string, unknown>).exitCode = null
  ;(child as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(child, 'pid', { configurable: true, value: 1 })
  return child
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('searchQuickOpenFilePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    checkRgAvailableMock.mockResolvedValue(true)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
  })

  it('finds fuzzy matches after 100k paths without returning excluded worktrees', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 's4354tgt',
      limit: 2,
      excludePaths: ['/repo/nested']
    })
    await flushMicrotasks()

    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(wslAwareSpawnMock.mock.calls[0][1]).toContain('--no-ignore-vcs')
    ;(child.stdout as unknown as EventEmitter).emit(
      'data',
      `${Array.from({ length: 100_100 }, (_, index) => `data/payload-${index}.bin`).join('\n')}\n`
    )
    ;(child.stdout as unknown as EventEmitter).emit(
      'data',
      'nested/src/sta-4354-target.ts\nsrc/sta-4354-target.ts\n'
    )
    child.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      paths: ['src/sta-4354-target.ts'],
      totalCount: 1,
      truncated: false
    })
  })

  it('kills the host scan when a superseded query aborts', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32,
      signal: controller.signal
    })
    await flushMicrotasks()

    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('requires ripgrep instead of retaining an unbounded fallback inventory', async () => {
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    checkRgAvailableMock.mockResolvedValue(false)

    await expect(
      searchQuickOpenFilePaths('C:\\repo', {} as Store, { query: 'target', limit: 32 })
    ).rejects.toThrow('Quick Open search requires ripgrep')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('does not start a host scan for empty or oversized queries', async () => {
    await expect(
      searchQuickOpenFilePaths('/repo', {} as Store, { query: '   ', limit: 32 })
    ).resolves.toEqual({ paths: [], totalCount: 0, truncated: false })
    await expect(
      searchQuickOpenFilePaths('/repo', {} as Store, {
        query: 'é'.repeat(1_025),
        limit: 32
      })
    ).resolves.toEqual({ paths: [], totalCount: 0, truncated: false })

    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })
})
