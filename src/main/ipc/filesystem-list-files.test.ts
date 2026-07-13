import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  spawnMock,
  resolveAuthorizedPathMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn(),
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

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'
import { EventEmitter } from 'node:events'
import type { Store } from '../persistence'
import type { ChildProcess } from 'node:child_process'

const SHA1 = '0123456789abcdef0123456789abcdef01234567'

function staged(mode: string, path: string): string {
  return `${mode} ${SHA1} 0\t${path}`
}

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

  return p
}

function isIgnoredRgPass(args: string[]): boolean {
  return args.includes('--no-ignore-vcs')
}

describe('filesystem-list-files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    checkRgAvailableMock.mockResolvedValue(true)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
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

  it('checks rg availability inside the registered WSL runtime for Windows-path worktrees', async () => {
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
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
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

  describe('git ls-files fallback', () => {
    it('falls back to git ls-files when rg is not available', async () => {
      checkRgAvailableMock.mockResolvedValue(false)

      let callIndex = 0
      const revParseProc = createMockProcess()
      const gitP1 = createMockProcess()
      const gitP2 = createMockProcess()

      spawnMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('rev-parse')) {
          return revParseProc
        }
        if (cmd === 'git' && args.includes('ls-files')) {
          callIndex++
          return callIndex === 1 ? gitP1 : gitP2
        }
        return createMockProcess()
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      setTimeout(() => {
        revParseProc.emit('close', 0, null)
      }, 0)
      setTimeout(() => {
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', 'src/index.ts')}\0`
        )
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', 'package.json')}\0`
        )
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', 'node_modules/dep/index.js')}\0`
        )
        gitP1.emit('close', 0, null)

        ;(gitP2.stdout as unknown as EventEmitter).emit('data', '.env.local\0')
        ;(gitP2.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\0')
        gitP2.emit('close', 0, null)
      }, 10)

      const result = await promise

      // Verify rg was never called
      const rgCalls = spawnMock.mock.calls.filter((call) => call[0] === 'rg')
      expect(rgCalls.length).toBe(0)

      // Verify git ls-files was called
      const gitCalls = spawnMock.mock.calls.filter(
        (call) => call[0] === 'git' && (call[1] as string[]).includes('ls-files')
      )
      expect(gitCalls.length).toBe(2)
      expect(gitCalls[0][1]).toContain('ls-files')
      expect(gitCalls[0][1]).toContain('-s')
      expect(gitCalls[0][1]).toContain('--directory')
      expect(gitCalls[1][1]).toContain('--directory')
      expect(gitCalls[1][1]).toContain('--no-empty-directory')

      // Should include valid files and filter node_modules
      expect(result).toContain('src/index.ts')
      expect(result).toContain('package.json')
      expect(result).toContain('.env.local')
      expect(result).toContain('dist/generated.js')
      expect(result).not.toContain('node_modules/dep/index.js')
    })

    it('git fallback applies hidden dir blocklist', async () => {
      checkRgAvailableMock.mockResolvedValue(false)

      const revParseProc = createMockProcess()
      const gitP1 = createMockProcess()
      const gitP2 = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('rev-parse')) {
          return revParseProc
        }
        if (cmd === 'git' && args.includes('ls-files')) {
          callIndex++
          return callIndex === 1 ? gitP1 : gitP2
        }
        return createMockProcess()
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      setTimeout(() => {
        revParseProc.emit('close', 0, null)
      }, 0)
      setTimeout(() => {
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', '.next/cache/1.js')}\0`
        )
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', '.vscode/settings.json')}\0`
        )
        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', '.github/workflows/ci.yml')}\0`
        )
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', `${staged('100644', 'valid.ts')}\0`)
        gitP1.emit('close', 0, null)

        gitP2.emit('close', 0, null)
      }, 10)

      const result = await promise

      expect(result).toEqual(['.github/workflows/ci.yml', 'valid.ts'])
    })

    it('settles and detaches git fallback scans that ignore timeout kills', async () => {
      checkRgAvailableMock.mockResolvedValue(false)
      vi.useFakeTimers()

      try {
        const revParseProc = createMockProcess()
        const gitP1 = createMockProcess()
        const gitP2 = createMockProcess()
        let callIndex = 0

        spawnMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'git' && args.includes('rev-parse')) {
            return revParseProc
          }
          if (cmd === 'git' && args.includes('ls-files')) {
            callIndex++
            return callIndex === 1 ? gitP1 : gitP2
          }
          return createMockProcess()
        })

        const storeMock = {} as unknown as Store
        const promise = listQuickOpenFiles('/mock/root', storeMock)

        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        revParseProc.emit('close', 0, null)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        ;(gitP1.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\0partial')

        const rejection = expect(promise).rejects.toThrow('git ls-files timed out')
        await vi.advanceTimersByTimeAsync(10000)

        await rejection
        expect(gitP1.kill).toHaveBeenCalled()
        expect(gitP2.kill).toHaveBeenCalled()
        expect((gitP1.stdout as unknown as EventEmitter).listenerCount('data')).toBe(0)
        expect((gitP1.stderr as unknown as EventEmitter).listenerCount('data')).toBe(0)
        expect(gitP1.listenerCount('error')).toBe(0)
        expect(gitP1.listenerCount('close')).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps primary results when only the ignored pass times out', async () => {
      checkRgAvailableMock.mockResolvedValue(false)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()

      try {
        const revParseProc = createMockProcess()
        const gitP1 = createMockProcess()
        const gitP2 = createMockProcess()
        let callIndex = 0

        spawnMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'git' && args.includes('rev-parse')) {
            return revParseProc
          }
          if (cmd === 'git' && args.includes('ls-files')) {
            callIndex++
            return callIndex === 1 ? gitP1 : gitP2
          }
          return createMockProcess()
        })

        const storeMock = {} as unknown as Store
        const promise = listQuickOpenFiles('/mock/root', storeMock)

        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        revParseProc.emit('close', 0, null)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        ;(gitP1.stdout as unknown as EventEmitter).emit(
          'data',
          `${staged('100644', 'src/index.ts')}\0`
        )
        gitP1.emit('close', 0, null)
        // Ignored entries streamed before the timeout are kept.
        ;(gitP2.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\0')

        await vi.advanceTimersByTimeAsync(10000)

        await expect(promise).resolves.toEqual(
          expect.arrayContaining(['src/index.ts', 'dist/generated.js'])
        )
        expect(gitP2.kill).toHaveBeenCalled()
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        warnSpy.mockRestore()
      }
    })

    it('does not fall back to git when rg is available', async () => {
      checkRgAvailableMock.mockResolvedValue(true)

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
        ;(p1.stdout as unknown as EventEmitter).emit('data', 'file.ts\n')
        p1.emit('close', 0, null)
        p2.emit('close', 0, null)
      }, 10)

      const result = await promise

      expect(result).toEqual(['file.ts'])
      const rgCalls = spawnMock.mock.calls.filter((call) => call[0] === 'rg')
      expect(rgCalls.every((call) => call[1].at(-1) === '.')).toBe(true)
      // git should never have been called
      const gitCalls = spawnMock.mock.calls.filter((call) => call[0] === 'git')
      expect(gitCalls.length).toBe(0)
    })
  })
})
