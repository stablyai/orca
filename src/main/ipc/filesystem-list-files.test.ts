import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock, resolveAuthorizedPathMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
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
})
