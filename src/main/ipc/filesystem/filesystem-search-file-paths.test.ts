import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type * as GitRunner from '../../git/command-runner/wsl-aware-spawn'
import type * as BundledRipgrepPath from '../../ripgrep/bundled-ripgrep-path'

const {
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  resolveAuthorizedPathMock,
  wslAwareSpawnMock
} = vi.hoisted(() => ({
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../../git/command-runner/wsl-aware-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('./access/filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('../../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('../local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'

function createMockProcess(spawned = true): ChildProcess {
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
  Object.defineProperty(child, 'pid', { configurable: true, value: spawned ? 1 : undefined })
  return child
}

const UNUSED_STORE: Store = Object.create(null)

function createSpawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn rg ${code}`), { code })
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
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : '/bundled/rg'
    )
  })

  it('preserves control characters within ranked paths', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const promise = searchQuickOpenFilePaths('/repo', UNUSED_STORE, {
      query: 'target',
      limit: 2
    })
    await flushMicrotasks()
    child.stdout?.emit('data', 'first\ntarget.ts\0target.ts\r\0')
    child.emit('close', 0, null)
    expect((await promise).paths.sort()).toEqual(['first\ntarget.ts', 'target.ts\r'].sort())
  })

  it('rejects and stops an oversized path rather than ranking a truncated suffix', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const promise = searchQuickOpenFilePaths('/repo', UNUSED_STORE, {
      query: 'target',
      limit: 2
    })
    await flushMicrotasks()
    child.stdout?.emit('data', 'x'.repeat(64 * 1024 + 1))
    await expect(promise).rejects.toThrow('file path exceeds the listing limit')
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.stdout?.emit('data', 'target.ts\0')
    child.emit('close', 0, null)
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
    expect(wslAwareSpawnMock.mock.calls[0][0]).toBe('/bundled/rg')
    expect(wslAwareSpawnMock.mock.calls[0][1]).toContain('--no-ignore-vcs')
    child.stdout?.emit(
      'data',
      `${Array.from({ length: 100_100 }, (_, index) => `data/payload-${index}.bin`).join('\0')}\0`
    )
    child.stdout?.emit('data', 'nested/src/sta-4354-target.ts\0src/sta-4354-target.ts\0')
    child.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      paths: ['src/sta-4354-target.ts'],
      totalCount: 1,
      truncated: false
    })
  })

  it('retries a transient rg spawn failure instead of reporting the bundled rg broken', async () => {
    const failed = createMockProcess(false)
    const succeeded = createMockProcess()
    wslAwareSpawnMock.mockReturnValueOnce(failed).mockReturnValueOnce(succeeded)
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'sta4354gitignored',
      limit: 32
    })
    await flushMicrotasks()

    failed.emit('error', createSpawnError('EAGAIN'))
    await flushMicrotasks()

    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2)
    succeeded.stdout?.emit('data', 'data/chunk-077568/sta-4354-gitignored-target.bin\0')
    succeeded.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      paths: ['data/chunk-077568/sta-4354-gitignored-target.bin'],
      totalCount: 1,
      truncated: false
    })
  })

  // Model error then negative close so the async cwd check faces the real spawn ordering.

  // Classify WSL cd failure 97 before generic unavailable checks for codes above rg's 0/1/2.

  it('names the unreachable root when the workspace is gone, not the bundled binary', async () => {
    const child = createMockProcess(false)
    wslAwareSpawnMock.mockReturnValue(child)
    resolveAuthorizedPathMock.mockImplementation(async () => '/definitely/not/here')
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32
    })
    await flushMicrotasks()

    child.emit('error', createSpawnError('ENOENT'))
    child.emit('close', -2, null)

    await expect(promise).rejects.toThrow('Search root is not reachable: /definitely/not/here')
  })
})
