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

  it('getStagedCommitContext reads branch, staged summary, and staged patch remotely', async () => {
    mux.request.mockImplementation(async (method, payload) => {
      expect(method).toBe('git.exec')
      if (payload.args[1] === '--show-current') {
        return { stdout: 'feature/ai-commit\n' }
      }
      if (payload.args[2] === '--name-status') {
        return { stdout: 'M\tREADME.md\n' }
      }
      if (payload.args[2] === '--patch') {
        return { stdout: 'diff --git a/README.md b/README.md\n+hello' }
      }
      throw new Error(`unexpected args: ${payload.args.join(' ')}`)
    })

    const result = await provider.getStagedCommitContext('/home/user/repo')

    expect(result).toEqual({
      branch: 'feature/ai-commit',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: 'diff --git a/README.md b/README.md\n+hello'
    })
    expect(mux.request).toHaveBeenCalledWith('git.exec', {
      args: ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      cwd: '/home/user/repo',
      __streamResponse: true
    })
  })

  it('getStagedCommitContext returns null when nothing is staged', async () => {
    mux.request.mockImplementation(async (_method, payload) => {
      if (payload.args[1] === '--show-current') {
        return { stdout: 'main\n' }
      }
      return { stdout: '' }
    })

    await expect(provider.getStagedCommitContext('/home/user/repo')).resolves.toBeNull()
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('getStagedCommitContext falls back when the remote staged patch overflows', async () => {
    mux.request.mockImplementation(async (_method, payload) => {
      if (payload.args[1] === '--show-current') {
        return { stdout: 'feature/ai-commit\n' }
      }
      if (payload.args[2] === '--name-status') {
        return { stdout: 'A\thuge.jsonl\n' }
      }
      throw Object.assign(new Error('git stdout exceeded maxBuffer.'), { code: 'ENOBUFS' })
    })

    await expect(provider.getStagedCommitContext('/home/user/repo')).resolves.toEqual({
      branch: 'feature/ai-commit',
      stagedSummary: 'A\thuge.jsonl',
      stagedPatch: ''
    })
  })

  it('getStagedCommitContext rethrows remote patch failures that are not buffer overflows', async () => {
    mux.request.mockImplementation(async (_method, payload) => {
      if (payload.args[1] === '--show-current') {
        return { stdout: 'feature/ai-commit\n' }
      }
      if (payload.args[2] === '--name-status') {
        return { stdout: 'M\tREADME.md\n' }
      }
      throw new Error('fatal: bad revision')
    })

    await expect(provider.getStagedCommitContext('/home/user/repo')).rejects.toThrow(
      'fatal: bad revision'
    )
  })

  it('keeps the transport alive for an agent response beyond the default request timeout', async () => {
    vi.useFakeTimers()
    try {
      const execResult = {
        stdout: 'Update docs',
        stderr: '',
        exitCode: 0,
        timedOut: false
      }
      mux.request.mockImplementation((_method, _payload, options) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('transport request timed out')),
            options?.timeoutMs ?? 30_000
          )
          setTimeout(() => {
            clearTimeout(timeout)
            resolve(execResult)
          }, 45_000)
        })
      })

      let state: 'pending' | 'resolved' | 'rejected' = 'pending'
      const pending = provider
        .executeCommitMessagePlan(
          {
            binary: 'codex',
            args: ['exec', 'PROMPT'],
            stdinPayload: null,
            label: 'Codex'
          },
          '/home/user/repo',
          60_000
        )
        .then(
          (result) => {
            state = 'resolved'
            return result
          },
          (error) => {
            state = 'rejected'
            throw error
          }
        )
      void pending.catch(() => {})

      await vi.advanceTimersByTimeAsync(30_000)
      expect(state).toBe('pending')
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(pending).resolves.toEqual(execResult)
      expect(mux.request).toHaveBeenCalledWith('agent.execNonInteractive', expect.any(Object), {
        timeoutMs: 65_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('executeCommitMessagePlan delegates the prepared plan to the relay', async () => {
    const execResult = {
      stdout: 'Update docs',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }
    mux.request.mockResolvedValue(execResult)

    const result = await provider.executeCommitMessagePlan(
      {
        binary: 'codex',
        args: ['exec', 'PROMPT'],
        stdinPayload: null,
        label: 'Codex'
      },
      '/home/user/repo',
      60_000
    )

    expect(mux.request).toHaveBeenCalledWith(
      'agent.execNonInteractive',
      {
        binary: 'codex',
        args: ['exec', 'PROMPT'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 60_000,
        operation: 'commit-message'
      },
      { timeoutMs: 65_000 }
    )
    expect(result).toEqual(execResult)
  })

  it('keeps SSH commit-message and pull-request execution lanes separate', async () => {
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
    const plan = {
      binary: 'codex',
      args: ['exec', 'PROMPT'],
      stdinPayload: null,
      label: 'Codex'
    }

    const commit = provider.executeCommitMessagePlan(plan, '/home/user/repo', 60_000)
    const pullRequest = provider.executeCommitMessagePlan(
      plan,
      '/home/user/repo',
      60_000,
      'pull-request-fields'
    )

    await waitForRequestCount(mux.request, 2)
    expect(mux.request).toHaveBeenNthCalledWith(
      1,
      'agent.execNonInteractive',
      {
        binary: 'codex',
        args: ['exec', 'PROMPT'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 60_000,
        operation: 'commit-message'
      },
      { timeoutMs: 65_000 }
    )
    expect(mux.request).toHaveBeenNthCalledWith(
      2,
      'agent.execNonInteractive',
      {
        binary: 'codex',
        args: ['exec', 'PROMPT'],
        cwd: '/home/user/repo',
        stdin: null,
        timeoutMs: 60_000,
        operation: 'pull-request-fields'
      },
      { timeoutMs: 65_000 }
    )

    await provider.cancelGenerateCommitMessage('/home/user/repo')
    await provider.cancelGenerateCommitMessage('/home/user/repo', 'pull-request-fields')

    expect(mux.request).toHaveBeenNthCalledWith(3, 'agent.cancelExec', {
      cwd: '/home/user/repo',
      operation: 'commit-message'
    })
    expect(mux.request).toHaveBeenNthCalledWith(4, 'agent.cancelExec', {
      cwd: '/home/user/repo',
      operation: 'pull-request-fields'
    })

    completeRequests.shift()?.()
    completeRequests.shift()?.()
    await Promise.all([commit, pullRequest])
  })

  it('cancelGenerateCommitMessage sends best-effort relay cancellation', async () => {
    await provider.cancelGenerateCommitMessage('/home/user/repo')

    expect(mux.request).toHaveBeenCalledWith('agent.cancelExec', {
      cwd: '/home/user/repo',
      operation: 'commit-message'
    })
  })
})
