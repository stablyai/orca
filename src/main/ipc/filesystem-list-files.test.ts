import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as BundledRipgrepPath from '../ripgrep/bundled-ripgrep-path'

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
  // runner.ts imports these from child_process; stubs prevent
  // "missing export" errors when the mock is resolved transitively.
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'
import { EventEmitter } from 'node:events'
import type { Store } from '../persistence'
import type { ChildProcess } from 'node:child_process'
import { FileListingCancelledError } from '../../shared/file-listing-cancellation'

const BUNDLED_RG = '/bundled/rg'
const BUNDLED_ERROR = "Orca's bundled search tool (ripgrep) could not start"

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

function createMissingRipgrepProcess(): ChildProcess {
  const child = createMockProcess()
  Object.defineProperty(child, 'pid', { value: undefined })
  Object.defineProperties(child, { stdout: { value: undefined }, stderr: { value: undefined } })
  void Promise.resolve().then(() => child.emit('close', -2, null))
  return child
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

  it('rejects a synchronous launch failure before cleanup has been initialized', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and workspace lookup are mocked above.
    await expect(listQuickOpenFiles('/repo', {} as Store)).rejects.toThrow('EMFILE')
  })

  // Why close(97) and not a spawn error: this is the WSL wrapper's "cd failed" code. It is above
  // rg's own 0/1/2, so a handler that checks it after the unavailable branch reports a broken
  // install instead -- a regression this file would otherwise not catch.
  it('names the unreachable root when the WSL wrapper cannot enter it', async () => {
    const child = createMockProcess()
    spawnMock.mockReturnValue(child)

    const promise = listQuickOpenFiles('/mock/root', {} as unknown as Store)
    setTimeout(() => child.emit('close', 97, null), 0)

    await expect(promise).rejects.toThrow('Search root is not reachable: /mock/root')
  })

  it('stops after the primary rg pass fills the result budget', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    spawnMock.mockImplementation((_cmd, args: string[]) => (isIgnoredRgPass(args) ? p2 : p1))
    const promise = listQuickOpenFiles(
      '/mock/root',
      {} as unknown as Store,
      undefined,
      undefined,
      2
    )

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'one.ts\ntwo.ts')
      p1.emit('close', 0, null)
    }, 0)
    const result = await promise

    expect(result).toEqual(['one.ts', 'two.ts'])
    expect(p1.kill).toHaveBeenCalled()
    expect(p2.kill).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[0]).toBe(BUNDLED_RG)
    expect(bundledRipgrepCommandMock).toHaveBeenCalledWith({ wsl: false })
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--version')
  })

  it('merges normal files and ignored files and filters correctly', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)
    await flushMicrotasks()
    expect(spawnMock).toHaveBeenCalledTimes(2)

    // Simulate stdout output for normal files
    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'file1.ts\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'node_modules/bad.js\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.git/config\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.github/workflows/ci.yml\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'dir1/') // incomplete line
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'file2.js\n')
      p1.emit('close', 0, null)

      // Simulate stdout output for ignored files
      ;(p2.stdout as unknown as EventEmitter).emit('data', '.env.local\n')
      ;(p2.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\n')
      ;(p2.stdout as unknown as EventEmitter).emit('data', 'file1.ts\n') // Duplicate
      ;(p2.stdout as unknown as EventEmitter).emit('data', 'node_modules/ignored.js\n')
      p2.emit('close', 0, null)
    }, 10)

    const result = await promise

    expect(result).toEqual([
      'file1.ts',
      '.github/workflows/ci.yml',
      'dir1/file2.js',
      '.env.local',
      'dist/generated.js'
    ])
  })

  it('spawns the bundled Linux rg inside the registered WSL runtime for Windows-path worktrees', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('C:\\repo', storeMock)

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      p1.emit('close', 0, null)
      p2.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts'])
    expect(getLocalGitOptionsForRegisteredWorktreeMock).toHaveBeenCalledWith(
      storeMock,
      'C:\\repo',
      'C:\\repo'
    )
    expect(bundledRipgrepCommandMock).toHaveBeenCalledWith({ wsl: true })
    expect(spawnMock.mock.calls.every((call) => call[0] === '/bundled/linux/rg')).toBe(true)
  })

  it('normalizes absolute WSL rg output for Windows-path worktrees', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('C:\\repo', storeMock)

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mnt/c/repo/src/index.ts\n')
      p1.emit('close', 0, null)
      p2.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts'])
  })

  it('treats a WSL launcher exit 127 as the bundled rg failing to start', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    Object.defineProperty(p1, 'pid', { value: 1 })
    Object.defineProperty(p2, 'pid', { value: 2 })
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    spawnMock.mockImplementation((_cmd, args: string[]) => (isIgnoredRgPass(args) ? p2 : p1))

    const promise = listQuickOpenFiles('C:\\repo', {} as unknown as Store)
    setTimeout(() => {
      p1.emit('close', 127, null)
      p2.emit('close', 0, null)
    }, 0)

    await expect(promise).rejects.toThrow(BUNDLED_ERROR)
    expect(spawnMock.mock.calls.some((call) => call[0] === 'git')).toBe(false)
  })

  it("rejects with the bundled-ripgrep error when a native launcher exits outside ripgrep's contract", async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    spawnMock.mockImplementation((_cmd, args: string[]) => (isIgnoredRgPass(args) ? p2 : p1))

    const promise = listQuickOpenFiles('/mock/root', {} as unknown as Store)
    setTimeout(() => p1.emit('close', 127, null), 0)

    await expect(promise).rejects.toThrow(BUNDLED_ERROR)
    expect(p2.kill).toHaveBeenCalled()
  })

  it('rejects rg failures instead of resolving a false-empty list', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    setTimeout(() => {
      p1.emit('close', 2, null)
      p2.emit('close', 0, null)
    }, 10)

    await expect(promise).rejects.toThrow('rg exited with code 2')
  })

  it('kills the sibling rg pass after one pass fails', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    setTimeout(() => {
      ;(p1 as unknown as { exitCode: number | null }).exitCode = 2
      p1.emit('close', 2, null)
    }, 10)

    await expect(promise).rejects.toThrow('rg exited with code 2')
    expect(p2.kill).toHaveBeenCalled()
  })

  it('accepts rg code 2 when rg emitted parseable paths first', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      p1.emit('close', 2, null)
      p2.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts'])
  })

  it('settles and detaches rg scans that ignore timeout kills', async () => {
    vi.useFakeTimers()

    try {
      const p1 = createMockProcess()
      const p2 = createMockProcess()

      spawnMock.mockImplementation((_cmd, args: string[]) => {
        if (isIgnoredRgPass(args)) {
          return p2
        }
        return p1
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      ;(p1.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\npartial')
      const rejection = expect(promise).rejects.toThrow('rg list timed out')

      await vi.advanceTimersByTimeAsync(10000)

      await rejection
      expect(p1.kill).toHaveBeenCalled()
      expect(p2.kill).toHaveBeenCalled()
      expect((p1.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect((p1.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
      expect(p1.listenerCount('error')).toBe(0)
      expect(p1.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills local rg scans when a paired listing is cancelled', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()
    spawnMock.mockImplementation((_cmd, args: string[]) => (isIgnoredRgPass(args) ? p2 : p1))
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

    await expect(promise).rejects.toBe(cancellation)
    expect(p1.kill).toHaveBeenCalledOnce()
    expect(p2.kill).toHaveBeenCalledOnce()
  })

  it('filters out .next, .cache, .stably, .vscode, .idea', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (isIgnoredRgPass(args)) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.next/cache/1.js\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.cache/data.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.stably/config.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.vscode/settings.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '.idea/workspace.xml\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'valid.ts\n')
      p1.emit('close', 0, null)

      // Empty ignored result
      p2.emit('close', 0, null)
    }, 10)

    const result = await promise

    expect(result).toEqual(['valid.ts'])
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

  describe('when the bundled rg cannot start', () => {
    it('kills only the admitted pass when ignored rg fails before spawn', async () => {
      const primary = createMockProcess()
      const missingIgnored = createMockProcess()
      Object.defineProperty(missingIgnored, 'pid', { value: undefined })
      spawnMock.mockImplementation((_cmd: string, args: string[]) =>
        isIgnoredRgPass(args) ? missingIgnored : primary
      )

      const promise = listQuickOpenFiles('/mock/root', {} as unknown as Store)
      await flushMicrotasks()
      expect(spawnMock).toHaveBeenCalledTimes(2)
      missingIgnored.emit('close', -2, null)

      await expect(promise).rejects.toThrow(BUNDLED_ERROR)
      expect(primary.kill).toHaveBeenCalled()
      expect(missingIgnored.kill).not.toHaveBeenCalled()
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
      expect(() => missingIgnored.emit('error', error)).not.toThrow()
      expect(missingIgnored.listenerCount('error')).toBe(0)
    })

    it('rejects with the bundled-ripgrep error instead of spawning git', async () => {
      spawnMock.mockImplementation(() => createMissingRipgrepProcess())

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked auth and runtime options never read the store.
      await expect(listQuickOpenFiles('/mock/root', {} as unknown as Store)).rejects.toThrow(
        BUNDLED_ERROR
      )
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock.mock.calls.some((call) => call[0] === 'git')).toBe(false)
    })

    it('reports fd pressure as a transient launch failure, not a broken install', async () => {
      spawnMock.mockImplementation(() => {
        const child = createMockProcess()
        Object.defineProperty(child, 'pid', { value: undefined })
        setTimeout(
          () => child.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' })),
          0
        )
        return child
      })

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked auth and runtime options never read the store.
      const listing = listQuickOpenFiles('/mock/root', {} as unknown as Store)

      await expect(listing).rejects.toThrow('rg could not start (EMFILE); try again')
    })
  })
})
