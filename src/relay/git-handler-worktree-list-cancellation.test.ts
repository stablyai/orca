import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import type { GitHandlerOperationHost } from './git-handler-operation-context'
import { createGitHandlerRelay } from './git-handler-test-harness'

const { statProbe, annotateLocks } = vi.hoisted(() => ({
  statProbe: vi.fn<(worktreePath: string) => Promise<void>>(),
  annotateLocks:
    vi.fn<
      (
        repoPath: string,
        rows: GitWorktreeInfo[],
        options?: { signal?: AbortSignal }
      ) => Promise<GitWorktreeInfo[]>
    >()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statProbe
}))
vi.mock('../shared/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: annotateLocks
}))

function porcelainRow(worktreePath: string): string {
  return `worktree ${worktreePath}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`
}

function unsupportedZError(): Error {
  return Object.assign(new Error('git usage error'), {
    code: 129,
    stderr: 'usage: git worktree list [<options>]\n'
  })
}

function unsupportedPathFormatError(): Error {
  return Object.assign(new Error('unsupported path format'), {
    stderr: 'error: unknown option `path-format=absolute`\n'
  })
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let relay: ReturnType<typeof createGitHandlerRelay>

beforeEach(() => {
  relay = createGitHandlerRelay()
  statProbe.mockReset()
  annotateLocks.mockReset().mockImplementation(async (_repoPath, rows) => rows)
})
afterEach(() => relay.handler.dispose())

describe('relay worktree listing request cancellation', () => {
  it('forwards the dispatcher signal through the old-Git existence fallback', async () => {
    const controller = new AbortController()
    const reason = new Error('Remote request closed')
    const porcelain =
      porcelainRow('/remote/repo') +
      Array.from({ length: 32 }, (_, index) => porcelainRow(`/remote/repo/task-${index}`)).join('')
    const git = vi.fn<GitHandlerOperationHost['git']>(async (args) => {
      if (args.includes('-z')) {
        throw unsupportedZError()
      }
      return { stdout: porcelain, stderr: '' }
    })
    Object.assign(relay.handler, { git })
    const releases: (() => void)[] = []
    statProbe.mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
    const outcome = vi.fn<(result: unknown) => void>()
    const observed = relay.dispatcher
      .callRequest(
        'git.listWorktrees',
        { repoPath: '/remote/repo' },
        { isStale: () => false, signal: controller.signal }
      )
      .then(
        (result) => outcome(result),
        (error: unknown) => outcome(error)
      )
    try {
      await nextTurn()
      expect(statProbe).toHaveBeenCalledTimes(8)
      expect(git.mock.calls.map(([, , options]) => options?.signal)).toEqual([
        controller.signal,
        controller.signal
      ])
      expect(annotateLocks).toHaveBeenCalledWith('/remote/repo', expect.any(Array), {
        signal: controller.signal
      })
      controller.abort(reason)
      await nextTurn()
      expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
    } finally {
      releases.splice(0).forEach((release) => release())
    }
    await observed
    await nextTurn()
    expect(statProbe).toHaveBeenCalledTimes(8)
    expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
  })

  it.each(['preferred', 'fallback'] as const)(
    'preserves cancellation from the %s normalization command',
    async (mode) => {
      const controller = new AbortController()
      const reason = new Error('Normalization canceled')
      const git = vi.fn<GitHandlerOperationHost['git']>(async (args, _cwd, options) => {
        expect(options?.signal).toBe(controller.signal)
        if (args[0] === 'worktree') {
          return { stdout: porcelainRow('/remote/git-store'), stderr: '' }
        }
        if (mode === 'fallback' && args.includes('--path-format=absolute')) {
          throw unsupportedPathFormatError()
        }
        controller.abort(reason)
        throw reason
      })
      Object.assign(relay.handler, { git })
      await expect(
        relay.dispatcher.callRequest(
          'git.listWorktrees',
          { repoPath: '/remote/repo' },
          { isStale: () => false, signal: controller.signal }
        )
      ).rejects.toBe(reason)
      const locationCommands = git.mock.calls
        .filter(([args]) => args[0] === 'rev-parse')
        .map(([args]) => args)
      expect(locationCommands).toEqual(
        mode === 'preferred'
          ? [
              [
                'rev-parse',
                '--path-format=absolute',
                '--show-toplevel',
                '--git-common-dir',
                '--git-dir'
              ]
            ]
          : [
              [
                'rev-parse',
                '--path-format=absolute',
                '--show-toplevel',
                '--git-common-dir',
                '--git-dir'
              ],
              ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir']
            ]
      )
      expect(statProbe).not.toHaveBeenCalled()
    }
  )

  it.each(['preferred', 'fallback'] as const)(
    'keeps separate-git-dir normalization working with the %s command',
    async (mode) => {
      const controller = new AbortController()
      const git = vi.fn<GitHandlerOperationHost['git']>(async (args, _cwd, options) => {
        expect(options?.signal).toBe(controller.signal)
        if (args[0] === 'worktree') {
          return { stdout: porcelainRow('/remote/git-store'), stderr: '' }
        }
        if (mode === 'fallback' && args.includes('--path-format=absolute')) {
          throw unsupportedPathFormatError()
        }
        return { stdout: '/remote/repo\n/remote/git-store\n/remote/git-store\n', stderr: '' }
      })
      Object.assign(relay.handler, { git })
      await expect(
        relay.dispatcher.callRequest(
          'git.listWorktrees',
          { repoPath: '/remote/repo' },
          { isStale: () => false, signal: controller.signal }
        )
      ).resolves.toEqual([
        expect.objectContaining({
          path: '/remote/repo',
          isMainWorktree: true
        })
      ])
      expect(statProbe).not.toHaveBeenCalled()
    }
  )

  it('rejects a pre-aborted dispatcher request before normalization or existence probes', async () => {
    const controller = new AbortController()
    const reason = new Error('Already closed')
    controller.abort(reason)
    const git = vi.fn<GitHandlerOperationHost['git']>(async () => ({
      stdout: porcelainRow('/remote/git-store'),
      stderr: ''
    }))
    Object.assign(relay.handler, { git })
    await expect(
      relay.dispatcher.callRequest(
        'git.listWorktrees',
        { repoPath: '/remote/repo' },
        { isStale: () => false, signal: controller.signal }
      )
    ).rejects.toBe(reason)
    expect(git).toHaveBeenCalledOnce()
    expect(annotateLocks).not.toHaveBeenCalled()
    expect(statProbe).not.toHaveBeenCalled()
  })
})
