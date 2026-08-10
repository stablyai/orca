import type * as FsPromises from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))
const { statMock, symlinkMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  symlinkMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, stat: statMock, symlink: symlinkMock }
})
vi.mock('./status', () => ({
  resolveGitDir: vi.fn(),
  runWithGitReadCacheInvalidation: (operation: () => unknown) => operation()
}))

import { addWorktree } from './worktree'

const REPO = '/repo'
const BRANCH = 'queue/feature'
const directory = { isDirectory: () => true, isFile: () => false }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

describe('local worktree create queue', () => {
  it('settles aborted and expired waiters before their predecessor releases', async () => {
    const releaseAdd = deferred()
    let addCalls = 0
    statMock.mockImplementation(async (value: string) => {
      if (value === join(REPO, '.git') || value === join(REPO, '.git', 'git-crypt')) {
        return directory
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    symlinkMock.mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockImplementation(async (args: string[], options: { cwd: string }) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${join(REPO, '.git')}\n` }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing branch'), { code: 1 })
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        addCalls += 1
        await releaseAdd.promise
        return { stdout: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
        return { stdout: join(REPO, '.git', 'worktrees', basename(options.cwd)) }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'true\n' }
      }
      return { stdout: '' }
    })
    const first = addWorktree(REPO, '/target-one', BRANCH, undefined, false, true, {
      timeout: 5_000
    })
    await vi.waitFor(() => expect(addCalls).toBe(1))
    const controller = new AbortController()
    const aborted = addWorktree(REPO, '/target-two', BRANCH, undefined, false, true, {
      signal: controller.signal,
      timeout: 1_000
    })
    const expired = addWorktree(REPO, '/target-three', BRANCH, undefined, false, true, {
      timeout: 50
    })
    const abortedResult = expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    const expiredResult = expect(expired).rejects.toThrow('timed out during lock queue')

    controller.abort()

    await abortedResult
    await expiredResult
    expect(addCalls).toBe(1)
    releaseAdd.resolve()
    await first
  })
})
