import { EventEmitter } from 'node:events'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, statMock, readFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  statMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock,
  readFile: readFileMock
}))

import { gitExecFileAsync } from './runner'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS
} from './wsl-linked-worktree-git-routing'

function createMockChild(): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = 1234
  child.kill = vi.fn()
  return child
}

async function withWindowsPlatform(run: () => Promise<void>): Promise<void> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetWslLinkedWorktreeGitRoutingForTests()
})

describe('WSL linked-worktree routing probe timeout', () => {
  it('retries discovery on the next production Git call', async () => {
    vi.useFakeTimers()
    await withWindowsPlatform(async () => {
      statMock
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue({ isDirectory: () => false, isFile: () => true })
      readFileMock.mockResolvedValue('gitdir: C:/main/.git/worktrees/linked\n')
      execFileMock.mockImplementation((command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => {
          if (command === 'wsl.exe') {
            callback?.(
              Object.assign(new Error('not a git repository'), { code: 128 }),
              '',
              'fatal: not a git repository'
            )
          } else {
            callback?.(null, 'host git recovered\n', '')
          }
        })
        return child
      })

      const first = gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        wslDistro: 'Ubuntu'
      })
      const firstFailure = expect(first).rejects.toThrow('not a git repository')
      await vi.advanceTimersByTimeAsync(WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS)
      await firstFailure

      await expect(
        gitExecFileAsync(['status', '--short'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu'
        })
      ).resolves.toEqual({ stdout: 'host git recovered\n', stderr: '' })

      expect(statMock).toHaveBeenCalledTimes(2)
      expect(execFileMock.mock.calls.map(([command]) => command)).toEqual(['wsl.exe', 'git'])
    })
  })
})
