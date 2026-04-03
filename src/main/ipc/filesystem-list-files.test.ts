import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock, resolveAuthorizedPathMock, checkRgAvailableMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'
import { EventEmitter } from 'events'
import type { Store } from '../persistence'
import type { ChildProcess } from 'child_process'

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

describe('filesystem-list-files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    checkRgAvailableMock.mockResolvedValue(true)
  })

  it('merges normal files and env files and filters correctly', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (args.includes('**/.env*')) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    // Simulate stdout output for normal files
    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/file1.ts\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/node_modules/bad.js\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.git/config\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.github/workflows/ci.yml\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/dir1/') // incomplete line
      ;(p1.stdout as unknown as EventEmitter).emit('data', 'file2.js\n')
      p1.emit('close')

      // Simulate stdout output for env files
      ;(p2.stdout as unknown as EventEmitter).emit('data', '/mock/root/.env.local\n')
      ;(p2.stdout as unknown as EventEmitter).emit('data', '/mock/root/file1.ts\n') // Duplicate
      p2.emit('close')
    }, 10)

    const result = await promise

    expect(result).toEqual(['file1.ts', '.github/workflows/ci.yml', 'dir1/file2.js', '.env.local'])
  })

  it('filters out .next, .cache, .stably, .vscode, .idea', async () => {
    const p1 = createMockProcess()
    const p2 = createMockProcess()

    spawnMock.mockImplementation((_cmd, args: string[]) => {
      if (args.includes('**/.env*')) {
        return p2
      }
      return p1
    })

    const storeMock = {} as unknown as Store
    const promise = listQuickOpenFiles('/mock/root', storeMock)

    setTimeout(() => {
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.next/cache/1.js\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.cache/data.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.stably/config.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.vscode/settings.json\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/.idea/workspace.xml\n')
      ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/valid.ts\n')
      p1.emit('close')

      // Empty env result
      p2.emit('close')
    }, 10)

    const result = await promise

    expect(result).toEqual(['valid.ts'])
  })

  describe('git ls-files fallback', () => {
    it('falls back to git ls-files when rg is not available', async () => {
      checkRgAvailableMock.mockResolvedValue(false)

      let callIndex = 0
      const gitP1 = createMockProcess()
      const gitP2 = createMockProcess()

      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'git') {
          callIndex++
          return callIndex === 1 ? gitP1 : gitP2
        }
        return createMockProcess()
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      setTimeout(() => {
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', 'package.json\n')
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', 'node_modules/dep/index.js\n')
        gitP1.emit('close')

        ;(gitP2.stdout as unknown as EventEmitter).emit('data', '.env.local\n')
        gitP2.emit('close')
      }, 10)

      const result = await promise

      // Verify rg was never called
      const rgCalls = spawnMock.mock.calls.filter((call) => call[0] === 'rg')
      expect(rgCalls.length).toBe(0)

      // Verify git ls-files was called
      const gitCalls = spawnMock.mock.calls.filter((call) => call[0] === 'git')
      expect(gitCalls.length).toBe(2)
      expect(gitCalls[0][1]).toContain('ls-files')

      // Should include valid files and filter node_modules
      expect(result).toContain('src/index.ts')
      expect(result).toContain('package.json')
      expect(result).toContain('.env.local')
      expect(result).not.toContain('node_modules/dep/index.js')
    })

    it('git fallback applies hidden dir blocklist', async () => {
      checkRgAvailableMock.mockResolvedValue(false)

      const gitP1 = createMockProcess()
      const gitP2 = createMockProcess()
      let callIndex = 0

      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'git') {
          callIndex++
          return callIndex === 1 ? gitP1 : gitP2
        }
        return createMockProcess()
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      setTimeout(() => {
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', '.next/cache/1.js\n')
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', '.vscode/settings.json\n')
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', '.github/workflows/ci.yml\n')
        ;(gitP1.stdout as unknown as EventEmitter).emit('data', 'valid.ts\n')
        gitP1.emit('close')

        gitP2.emit('close')
      }, 10)

      const result = await promise

      expect(result).toEqual(['.github/workflows/ci.yml', 'valid.ts'])
    })

    it('does not fall back to git when rg is available', async () => {
      checkRgAvailableMock.mockResolvedValue(true)

      const p1 = createMockProcess()
      const p2 = createMockProcess()

      spawnMock.mockImplementation((_cmd, args: string[]) => {
        if (args.includes('**/.env*')) {
          return p2
        }
        return p1
      })

      const storeMock = {} as unknown as Store
      const promise = listQuickOpenFiles('/mock/root', storeMock)

      setTimeout(() => {
        ;(p1.stdout as unknown as EventEmitter).emit('data', '/mock/root/file.ts\n')
        p1.emit('close')
        p2.emit('close')
      }, 10)

      const result = await promise

      expect(result).toEqual(['file.ts'])
      // git should never have been called
      const gitCalls = spawnMock.mock.calls.filter((call) => call[0] === 'git')
      expect(gitCalls.length).toBe(0)
    })
  })
})
