import { describe, expect, it, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { listFilesWithGit } from './fs-handler-git-fallback'
import { listFilesWithRg } from './fs-handler-list-files'

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

describe('relay quick open ignored file listing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rg ignored pass includes ignored non-env files and keeps blocklists/excludes', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--no-ignore-vcs')) {
        return ignoredProc
      }
      return primaryProc
    })

    const promise = listFilesWithRg('/remote/root', ['packages/other'])

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      primaryProc.emit('close', 0, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\n')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'node_modules/pkg/index.js\n')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'packages/other/src/x.ts\n')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts', 'dist/generated.js'])

    const ignoredArgs = spawnMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('--no-ignore-vcs')
    )?.[1] as string[]
    expect(ignoredArgs).toBeDefined()
    expect(ignoredArgs).toContain('--no-ignore-vcs')
    expect(ignoredArgs).not.toContain('.env*')
    expect(ignoredArgs).not.toContain('**/.env*')
    expect(ignoredArgs).toContain('!**/node_modules')
    expect(ignoredArgs).toContain('!packages/other')
    expect(ignoredArgs).toContain('!packages/other/**')
  })

  it('git fallback ignored pass includes ignored non-env files', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit('/remote/root', ['packages/other'])

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      primaryProc.emit('close', 0, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\n')
      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'packages/other/src/x.ts\n')
      ignoredProc.emit('close', 0, null)
    }, 10)

    await expect(promise).resolves.toEqual(['src/index.ts', 'dist/generated.js'])

    const ignoredArgs = spawnMock.mock.calls[1][1] as string[]
    expect(ignoredArgs).toEqual([
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      '.',
      ':(exclude,glob)packages/other',
      ':(exclude,glob)packages/other/**'
    ])
  })

  it('git fallback rejects signal exits instead of returning partial results', async () => {
    const primaryProc = createMockProcess()
    const ignoredProc = createMockProcess()
    let callIndex = 0

    spawnMock.mockImplementation(() => {
      callIndex++
      return callIndex === 1 ? primaryProc : ignoredProc
    })

    const promise = listFilesWithGit('/remote/root')

    setTimeout(() => {
      ;(primaryProc.stdout as unknown as EventEmitter).emit('data', 'src/index.ts\n')
      primaryProc.emit('close', 0, null)

      ;(ignoredProc.stdout as unknown as EventEmitter).emit('data', 'dist/generated.js\n')
      ignoredProc.emit('close', null, 'SIGTERM')
    }, 10)

    await expect(promise).rejects.toThrow('git ls-files killed by SIGTERM')
  })
})
