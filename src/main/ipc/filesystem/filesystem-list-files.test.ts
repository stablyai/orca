import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as BundledRipgrepPath from '../../ripgrep/bundled-ripgrep-path'

const {
  spawnMock,
  resolveAuthorizedPathMock,
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  // Transitive runner imports require both child_process exports in the mock.
  execFile: vi.fn(),
  execFileSync: vi.fn()
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

import { listQuickOpenFiles } from './filesystem-list-files'
import { EventEmitter } from 'node:events'
import type { Store } from '../../persistence/loading-store/store'
import type { ChildProcess } from 'node:child_process'
import { FileListingCancelledError } from '../../../shared/file-listing-cancellation'

const BUNDLED_RG = '/bundled/rg'

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
  ;(p as unknown as Record<string, unknown>).exitCode = null
  ;(p as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(p, 'pid', { configurable: true, value: 1 })

  return p
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}

function isIgnoredRgPass(args: string[]): boolean {
  return args.includes('--no-ignore-vcs')
}

describe('filesystem-list-files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : BUNDLED_RG
    )
  })

  it('counts NUL-delimited filenames containing newlines as one result each', async () => {
    const child = createMockProcess()
    spawnMock.mockReturnValue(child)
    const store: Store = Object.create(null)
    const promise = listQuickOpenFiles('/repo', store, undefined, undefined, 2)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    child.stdout?.emit('data', 'first\nsecond.ts\0trailing\r\0third.ts\0')
    await expect(promise).resolves.toEqual(['first\nsecond.ts', 'trailing\r'])
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects a synchronous launch failure before cleanup has been initialized', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and workspace lookup are mocked above.
    await expect(listQuickOpenFiles('/repo', {} as Store)).rejects.toThrow('EMFILE')
  })

  // WSL cd failure is 97; classify it before generic unavailable checks for codes above rg's 0/1/2.

  it('keeps source files first when only a serialized byte budget is provided', async () => {
    const source = createMockProcess()
    const broad = createMockProcess()
    spawnMock.mockImplementation((_command, args: string[]) =>
      isIgnoredRgPass(args) ? broad : source
    )
    const listing = listQuickOpenFiles(
      '/mock/root',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and workspace lookup are mocked above.
      {} as Store,
      undefined,
      undefined,
      undefined,
      20
    )
    await flushMicrotasks()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--no-ignore-vcs')
    source.stdout?.emit('data', 'source.ts\0')
    source.emit('close', 0, null)
    await flushMicrotasks()
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock.mock.calls[1]?.[1]).toContain('--no-ignore-vcs')
    broad.stdout?.emit('data', 'ignored-file.ts\0')
    await expect(listing).resolves.toEqual(['source.ts'])
    expect(broad.kill).toHaveBeenCalledOnce()
  })

  it('settles and detaches rg scans that ignore timeout kills', async () => {
    vi.useFakeTimers()

    try {
      const p1 = createMockProcess()

      spawnMock.mockReturnValue(p1)

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      p1.stdout?.emit('data', 'src/index.ts\0partial')
      const rejection = expect(promise).rejects.toThrow('rg list timed out')

      await vi.advanceTimersByTimeAsync(10000)

      await rejection
      expect(p1.kill).toHaveBeenCalled()
      expect((p1.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((p1.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(p1.listenerCount('error')).toBe(0)
      expect(p1.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets cancellation win a native-unavailable race', async () => {
    const first = createMockProcess()
    Object.defineProperty(first, 'pid', { value: undefined })
    spawnMock.mockReturnValue(first)
    const controller = new AbortController()
    const cancellation = new FileListingCancelledError('superseded')

    const promise = listQuickOpenFiles(
      '/mock/root',
      {} as unknown as Store,
      undefined,
      controller.signal
    )
    await flushMicrotasks()
    controller.abort(cancellation)
    first.emit('close', -2, null)

    await expect(promise).rejects.toBe(cancellation)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls.some((call) => call[0] === 'git')).toBe(false)
    const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
    expect(() => first.emit('error', error)).not.toThrow()
    expect(first.listenerCount('error')).toBe(0)
  })
})
