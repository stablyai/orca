import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  waitForRequestCount,
  type MockMultiplexer
} from './ssh-git-provider-test-harness'

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('clone sends git.clone request and forwards matching progress notifications', async () => {
    const unsubscribe = vi.fn()
    const onProgress = vi.fn()
    mux.onNotificationByMethod.mockReturnValue(unsubscribe)
    mux.request.mockImplementationOnce(async (_method, params) => {
      const progressHandler = mux.onNotificationByMethod.mock.calls[0][1]
      progressHandler({
        progressId: params.progressId,
        phase: 'Receiving objects',
        percent: 42
      })
      progressHandler({
        progressId: 'other-clone',
        phase: 'Receiving objects',
        percent: 99
      })
      return { stdout: '', stderr: '' }
    })

    await provider.clone(['clone', '--progress', '--', 'url', 'repo'], '/home/user', {
      timeoutMs: 1000,
      onProgress
    })

    expect(mux.request).toHaveBeenCalledWith(
      'git.clone',
      expect.objectContaining({
        args: ['clone', '--progress', '--', 'url', 'repo'],
        cwd: '/home/user',
        progressId: expect.stringMatching(/^clone-/)
      }),
      { signal: undefined, timeoutMs: 1000 }
    )
    expect(mux.onNotificationByMethod).toHaveBeenCalledWith(
      'git.cloneProgress',
      expect.any(Function)
    )
    expect(onProgress).toHaveBeenCalledWith({ phase: 'Receiving objects', percent: 42 })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('reports an actionable reconnect message when the relay does not support cloning', async () => {
    const methodNotFound = new Error('Method not found: git.clone') as Error & { code?: number }
    methodNotFound.code = -32601
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(
      provider.clone(['clone', '--progress', '--', 'url', 'repo'], '/home/user')
    ).rejects.toThrow(
      'SSH clone support is unavailable on this relay. Reconnect the SSH target to update Orca on the host, then try again.'
    )
  })

  it('execNonInteractive delegates fixed binary commands to the relay', async () => {
    const execResult = {
      stdout: '10.0.0\n',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }
    mux.request.mockResolvedValue(execResult)

    const result = await provider.execNonInteractive('pnpm', ['--version'], '/home/user/repo', 8000)

    expect(mux.request).toHaveBeenCalledWith(
      'agent.execNonInteractive',
      {
        binary: 'pnpm',
        args: ['--version'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 8000
      },
      { timeoutMs: 13_000 }
    )
    expect(result).toEqual(execResult)
  })

  it('execNonInteractive forwards environment variables to the relay', async () => {
    const execResult = {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }
    mux.request.mockResolvedValue(execResult)

    await provider.execNonInteractive(
      '/bin/bash',
      ['-lc', 'echo "$ORCA_WORKTREE_PATH"'],
      '/home/user/repo',
      120_000,
      undefined,
      {
        ORCA_ROOT_PATH: '/home/user/repo',
        ORCA_WORKTREE_PATH: '/home/user/repo-feature'
      }
    )

    expect(mux.request).toHaveBeenCalledWith(
      'agent.execNonInteractive',
      {
        binary: '/bin/bash',
        args: ['-lc', 'echo "$ORCA_WORKTREE_PATH"'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 120_000,
        env: {
          ORCA_ROOT_PATH: '/home/user/repo',
          ORCA_WORKTREE_PATH: '/home/user/repo-feature'
        }
      },
      { timeoutMs: 125_000 }
    )
  })

  it('cancelNonInteractiveExec sends best-effort relay cancellation', async () => {
    await provider.cancelNonInteractiveExec('/home/user/repo')

    expect(mux.request).toHaveBeenCalledWith('agent.cancelExec', { cwd: '/home/user/repo' })
  })

  it('exec forwards abort and timeout options to the relay request', async () => {
    const controller = new AbortController()
    mux.request.mockResolvedValue({ stdout: '', stderr: '' })

    await provider.exec(
      ['clone', '--progress', '--', 'git@example.com:repo.git', 'repo'],
      '/home/user',
      {
        signal: controller.signal,
        timeoutMs: 60_000
      }
    )

    expect(mux.request).toHaveBeenCalledWith(
      'git.exec',
      {
        args: ['clone', '--progress', '--', 'git@example.com:repo.git', 'repo'],
        cwd: '/home/user',
        // Why: exec opts into response streaming so a large stdout is chunked
        // onto the bulk lane; old relays ignore the flag.
        __streamResponse: true
      },
      {
        signal: controller.signal,
        timeoutMs: 60_000
      }
    )
  })

  it('serializes non-interactive relay execs for the same cwd and operation', async () => {
    const completeRequests: (() => void)[] = []
    mux.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRequests.push(() =>
            resolve({
              stdout: '',
              stderr: '',
              exitCode: 0,
              timedOut: false
            })
          )
        })
    )

    const first = provider.execNonInteractive('pnpm', ['store', 'prune'], '/home/user/repo', 8000)
    const second = provider.execNonInteractive('pnpm', ['install'], '/home/user/repo', 8000)

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)

    completeRequests.shift()?.()
    await first
    await waitForRequestCount(mux.request, 2)

    expect(mux.request).toHaveBeenNthCalledWith(
      2,
      'agent.execNonInteractive',
      {
        binary: 'pnpm',
        args: ['install'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 8000
      },
      { timeoutMs: 13_000 }
    )
    completeRequests.shift()?.()
    await second
  })

  it('cancels a queued non-interactive exec without canceling the active relay child', async () => {
    const completeRequests: (() => void)[] = []
    mux.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRequests.push(() =>
            resolve({
              stdout: '',
              stderr: '',
              exitCode: 0,
              timedOut: false
            })
          )
        })
    )

    const first = provider.execNonInteractive('pnpm', ['store', 'prune'], '/home/user/repo', 8000)
    const second = provider.execNonInteractive('pnpm', ['install'], '/home/user/repo', 8000)

    await waitForRequestCount(mux.request, 1)
    await provider.cancelNonInteractiveExec('/home/user/repo')

    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).not.toHaveBeenCalledWith('agent.cancelExec', { cwd: '/home/user/repo' })

    completeRequests.shift()?.()
    await first
    const secondResult = await second

    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(secondResult).toMatchObject({ canceled: true })
  })

  it('uses an exec abort signal to cancel the matching active relay child with queued work present', async () => {
    const completeRequests: (() => void)[] = []
    mux.request.mockImplementation((method) => {
      if (method === 'agent.cancelExec') {
        return Promise.resolve({ canceled: true })
      }
      return new Promise((resolve) => {
        completeRequests.push(() =>
          resolve({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false
          })
        )
      })
    })

    const controller = new AbortController()
    const first = provider.execNonInteractive(
      'pnpm',
      ['store', 'prune'],
      '/home/user/repo',
      8000,
      controller.signal
    )
    const second = provider.execNonInteractive('pnpm', ['install'], '/home/user/repo', 8000)

    await waitForRequestCount(mux.request, 1)
    controller.abort()
    await waitForRequestCount(mux.request, 2)

    expect(mux.request).toHaveBeenNthCalledWith(2, 'agent.cancelExec', { cwd: '/home/user/repo' })

    completeRequests.shift()?.()
    await first
    await waitForRequestCount(mux.request, 3)
    expect(mux.request).toHaveBeenNthCalledWith(
      3,
      'agent.execNonInteractive',
      {
        binary: 'pnpm',
        args: ['install'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 8000
      },
      { timeoutMs: 13_000 }
    )
    completeRequests.shift()?.()
    await second
  })
})
