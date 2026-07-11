/* eslint-disable max-lines -- Why: this suite covers the SSH git provider's one-RPC-per-method contract; splitting it would duplicate the shared mux fixture. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn().mockReturnValue(vi.fn()),
    // Why: requestGitStreamable subscribes to onDispose before awaiting the
    // response so it can reject in-flight reassembly if the link drops.
    onDispose: vi.fn().mockReturnValue(vi.fn()),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

async function waitForRequestCount(mock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= count) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

function deferredValue<T>(value: T): { promise: Promise<T>; resolve: () => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve: () => resolve(value) }
}

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('returns the connectionId', () => {
    expect(provider.getConnectionId()).toBe('conn-1')
  })

  it('getStatus sends git.status request', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    const result = await provider.getStatus('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.status', { worktreePath: '/home/user/repo' })
    expect(result).toEqual(statusResult)
  })

  it('getStatus forwards includeIgnored only when requested', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown', ignoredPaths: ['dist/'] }
    mux.request.mockResolvedValue(statusResult)

    await provider.getStatus('/home/user/repo', { includeIgnored: true })
    await provider.getStatus('/home/user/repo', { includeIgnored: false })

    expect(mux.request).toHaveBeenNthCalledWith(1, 'git.status', {
      worktreePath: '/home/user/repo',
      includeIgnored: true
    })
    expect(mux.request).toHaveBeenNthCalledWith(2, 'git.status', {
      worktreePath: '/home/user/repo'
    })
  })

  it('getStatus forwards upstream-negative-cache bypass only when requested', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    await provider.getStatus('/home/user/repo', { bypassEffectiveUpstreamNegativeCache: true })
    await provider.getStatus('/home/user/repo', { bypassEffectiveUpstreamNegativeCache: false })

    expect(mux.request).toHaveBeenNthCalledWith(1, 'git.status', {
      worktreePath: '/home/user/repo',
      bypassEffectiveUpstreamNegativeCache: true
    })
    expect(mux.request).toHaveBeenNthCalledWith(2, 'git.status', {
      worktreePath: '/home/user/repo'
    })
  })

  it('getSubmoduleStatus sends git.submoduleStatus request', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    const result = await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')

    expect(mux.request).toHaveBeenCalledWith('git.submoduleStatus', {
      worktreePath: '/home/user/repo',
      submodulePath: 'vendor/lib',
      area: 'unstaged'
    })
    expect(result).toEqual(statusResult)
  })

  it('getSubmoduleStatus forwards the requested source-control area', async () => {
    const statusResult = { entries: [], conflictOperation: 'unknown' }
    mux.request.mockResolvedValue(statusResult)

    await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib', 'staged')

    expect(mux.request).toHaveBeenCalledWith('git.submoduleStatus', {
      worktreePath: '/home/user/repo',
      submodulePath: 'vendor/lib',
      area: 'staged'
    })
  })

  it('reports an actionable reconnect message when the relay lacks submodule status', async () => {
    const methodNotFound = new Error('Method not found: git.submoduleStatus') as Error & {
      code?: number
    }
    methodNotFound.code = -32601
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')).rejects.toThrow(
      'SSH submodule diff support is unavailable on this relay. Reconnect the SSH target to update Orca on the host, then try again.'
    )
  })

  it('rethrows non-method-not-found submodule status errors unchanged', async () => {
    mux.request.mockRejectedValueOnce(new Error('fatal: not a submodule'))

    await expect(provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')).rejects.toThrow(
      'fatal: not a submodule'
    )
  })

  it('checkIgnoredPaths sends git.checkIgnored request', async () => {
    mux.request.mockResolvedValue(['dist/bundle.js'])

    const result = await provider.checkIgnoredPaths('/home/user/repo', ['dist/bundle.js'])

    expect(mux.request).toHaveBeenCalledWith('git.checkIgnored', {
      worktreePath: '/home/user/repo',
      paths: ['dist/bundle.js']
    })
    expect(result).toEqual(['dist/bundle.js'])
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

  it('getHistory sends git.history request', async () => {
    const historyResult = {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    }
    mux.request.mockResolvedValue(historyResult)

    const result = await provider.getHistory('/home/user/repo', {
      limit: 25,
      baseRef: 'origin/main'
    })

    expect(mux.request).toHaveBeenCalledWith('git.history', {
      worktreePath: '/home/user/repo',
      limit: 25,
      baseRef: 'origin/main'
    })
    expect(result).toEqual(historyResult)
  })

  it('commit sends git.commit request', async () => {
    const commitResult = { success: true }
    mux.request.mockResolvedValue(commitResult)

    const result = await provider.commit('/home/user/repo', 'feat: add source control commit')

    expect(mux.request).toHaveBeenCalledWith('git.commit', {
      worktreePath: '/home/user/repo',
      message: 'feat: add source control commit'
    })
    expect(result).toEqual(commitResult)
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

    expect(mux.request).toHaveBeenCalledWith('agent.execNonInteractive', {
      binary: 'pnpm',
      args: ['--version'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 8000
    })
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

    expect(mux.request).toHaveBeenCalledWith('agent.execNonInteractive', {
      binary: '/bin/bash',
      args: ['-lc', 'echo "$ORCA_WORKTREE_PATH"'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 120_000,
      env: {
        ORCA_ROOT_PATH: '/home/user/repo',
        ORCA_WORKTREE_PATH: '/home/user/repo-feature'
      }
    })
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

    expect(mux.request).toHaveBeenCalledWith('agent.execNonInteractive', {
      binary: 'codex',
      args: ['exec', 'PROMPT'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 60_000,
      operation: 'commit-message'
    })
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
    expect(mux.request).toHaveBeenNthCalledWith(1, 'agent.execNonInteractive', {
      binary: 'codex',
      args: ['exec', 'PROMPT'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 60_000,
      operation: 'commit-message'
    })
    expect(mux.request).toHaveBeenNthCalledWith(2, 'agent.execNonInteractive', {
      binary: 'codex',
      args: ['exec', 'PROMPT'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 60_000,
      operation: 'pull-request-fields'
    })

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

    expect(mux.request).toHaveBeenNthCalledWith(2, 'agent.execNonInteractive', {
      binary: 'pnpm',
      args: ['install'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 8000
    })
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
    expect(mux.request).toHaveBeenNthCalledWith(3, 'agent.execNonInteractive', {
      binary: 'pnpm',
      args: ['install'],
      cwd: '/home/user/repo',
      stdin: null,
      timeoutMs: 8000
    })
    completeRequests.shift()?.()
    await second
  })

  it('cancelGenerateCommitMessage sends best-effort relay cancellation', async () => {
    await provider.cancelGenerateCommitMessage('/home/user/repo')

    expect(mux.request).toHaveBeenCalledWith('agent.cancelExec', {
      cwd: '/home/user/repo',
      operation: 'commit-message'
    })
  })

  it('getDiff sends git.diff request', async () => {
    const diffResult = { kind: 'text', originalContent: '', modifiedContent: 'hello' }
    mux.request.mockResolvedValue(diffResult)

    const result = await provider.getDiff('/home/user/repo', 'src/index.ts', true)
    expect(mux.request).toHaveBeenCalledWith('git.diff', {
      worktreePath: '/home/user/repo',
      filePath: 'src/index.ts',
      staged: true,
      // Why: opts into response streaming; a small result still comes back as a
      // single frame (relay decides), and old relays ignore the flag.
      __streamResponse: true
    })
    expect(result).toEqual(diffResult)
  })

  it('stageFile sends git.stage request', async () => {
    await provider.stageFile('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.stage', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('unstageFile sends git.unstage request', async () => {
    await provider.unstageFile('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.unstage', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('bulkStageFiles sends git.bulkStage request', async () => {
    await provider.bulkStageFiles('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkStage', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('bulkUnstageFiles sends git.bulkUnstage request', async () => {
    await provider.bulkUnstageFiles('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkUnstage', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('discardChanges sends git.discard request', async () => {
    await provider.discardChanges('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.discard', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('bulkDiscardChanges sends git.bulkDiscard request', async () => {
    await provider.bulkDiscardChanges('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkDiscard', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('detectConflictOperation sends git.conflictOperation request', async () => {
    mux.request.mockResolvedValue('rebase')
    const result = await provider.detectConflictOperation('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.conflictOperation', {
      worktreePath: '/home/user/repo'
    })
    expect(result).toBe('rebase')
  })

  it('getBranchCompare sends git.branchCompare request', async () => {
    const compareResult = { summary: { ahead: 2, behind: 0 }, entries: [] }
    mux.request.mockResolvedValue(compareResult)

    const result = await provider.getBranchCompare('/home/user/repo', 'main')
    expect(mux.request).toHaveBeenCalledWith('git.branchCompare', {
      worktreePath: '/home/user/repo',
      baseRef: 'main'
    })
    expect(result).toEqual(compareResult)
  })

  it('getUpstreamStatus sends git.upstreamStatus request', async () => {
    const upstreamResult = { hasUpstream: true, upstreamName: 'origin/main', ahead: 1, behind: 0 }
    mux.request.mockResolvedValue(upstreamResult)

    const result = await provider.getUpstreamStatus('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.upstreamStatus', {
      worktreePath: '/home/user/repo'
    })
    expect(result).toEqual(upstreamResult)
  })

  it('getUpstreamStatus forwards an explicit push target', async () => {
    const upstreamResult = { hasUpstream: true, upstreamName: 'fork/feature', ahead: 0, behind: 1 }
    mux.request.mockResolvedValue(upstreamResult)

    const pushTarget = { remoteName: 'fork', branchName: 'feature' }
    const result = await provider.getUpstreamStatus('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.upstreamStatus', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
    expect(result).toEqual(upstreamResult)
  })

  it('pushBranch sends git.push request and forwards publish mode and target', async () => {
    await provider.pushBranch('/home/user/repo', true, {
      remoteName: 'pr-fork-orca',
      branchName: 'contributor/fix'
    })
    expect(mux.request).toHaveBeenCalledWith('git.push', {
      worktreePath: '/home/user/repo',
      publish: true,
      pushTarget: {
        remoteName: 'pr-fork-orca',
        branchName: 'contributor/fix'
      }
    })
  })

  it('pushBranch forwards force-with-lease mode', async () => {
    await provider.pushBranch('/home/user/repo', false, undefined, { forceWithLease: true })

    expect(mux.request).toHaveBeenCalledWith('git.push', {
      worktreePath: '/home/user/repo',
      publish: false,
      pushTarget: undefined,
      forceWithLease: true
    })
  })

  it('pullBranch sends git.pull request', async () => {
    await provider.pullBranch('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.pull', {
      worktreePath: '/home/user/repo'
    })
  })

  it('pullBranch forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.pullBranch('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.pull', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('fastForwardBranch sends git.fastForward request', async () => {
    await provider.fastForwardBranch('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.fastForward', {
      worktreePath: '/home/user/repo'
    })
  })

  it('fastForwardBranch forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.fastForwardBranch('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.fastForward', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('rebaseFromBase sends git.rebaseFromBase request', async () => {
    await provider.rebaseFromBase('/home/user/repo', 'upstream/main')

    expect(mux.request).toHaveBeenCalledWith('git.rebaseFromBase', {
      worktreePath: '/home/user/repo',
      baseRef: 'upstream/main'
    })
  })

  it('fetchRemote sends git.fetch request', async () => {
    await provider.fetchRemote('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.fetch', {
      worktreePath: '/home/user/repo'
    })
  })

  it('fetchRemote forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.fetchRemote('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.fetch', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('syncForkDefaultBranch sends git.forkSync request', async () => {
    const syncResult = {
      status: 'synced',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      branchName: 'main',
      ahead: 0,
      behind: 2
    }
    mux.request.mockResolvedValue(syncResult)

    const expectedUpstream = { owner: 'stablyai', repo: 'orca' }
    const result = await provider.syncForkDefaultBranch('/home/user/repo', expectedUpstream)

    expect(mux.request).toHaveBeenCalledWith('git.forkSync', {
      worktreePath: '/home/user/repo',
      expectedUpstream
    })
    expect(result).toEqual(syncResult)
  })

  it('fetchRemoteTrackingRef sends git.fetchRemoteTrackingRef request', async () => {
    await provider.fetchRemoteTrackingRef(
      '/home/user/repo',
      'origin',
      'main',
      'refs/remotes/origin/main',
      { skipAutoMaintenance: true }
    )

    expect(mux.request).toHaveBeenCalledWith('git.fetchRemoteTrackingRef', {
      worktreePath: '/home/user/repo',
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      skipAutoMaintenance: true
    })
  })

  it('fetchGitLabMergeRequestHead sends git.fetchGitLabMergeRequestHead request', async () => {
    await provider.fetchGitLabMergeRequestHead('/home/user/repo', 'origin', 42)

    expect(mux.request).toHaveBeenCalledWith('git.fetchGitLabMergeRequestHead', {
      worktreePath: '/home/user/repo',
      remote: 'origin',
      mrIid: 42
    })
  })

  it('getBranchDiff sends git.branchDiff request', async () => {
    const diffs = [{ kind: 'text', originalContent: '', modifiedContent: 'new' }]
    mux.request.mockResolvedValue(diffs)

    const result = await provider.getBranchDiff('/home/user/repo', 'main')
    expect(mux.request).toHaveBeenCalledWith('git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      __streamResponse: true
    })
    expect(result).toEqual(diffs)
  })

  it('coalesces concurrent identical diff RPCs while in flight', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValue(pendingDiff.promise)

    const reads = Array.from({ length: 8 }, () =>
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingDiff.resolve()

    await expect(Promise.all(reads)).resolves.toEqual(Array(8).fill(diff))

    mux.request.mockReset()
    const branchDiffs = [diff]
    const pendingBranchDiff = deferredValue(branchDiffs)
    mux.request.mockReturnValue(pendingBranchDiff.promise)

    const branchReads = Array.from({ length: 8 }, () =>
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      })
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingBranchDiff.resolve()
    await expect(Promise.all(branchReads)).resolves.toEqual(Array(8).fill(branchDiffs))

    mux.request.mockReset()
    const pendingCommitDiff = deferredValue(diff)
    mux.request.mockReturnValue(pendingCommitDiff.promise)

    const commitReads = Array.from({ length: 8 }, () =>
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      })
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingCommitDiff.resolve()
    await expect(Promise.all(commitReads)).resolves.toEqual(Array(8).fill(diff))
  })

  it('retries diff RPCs after an in-flight rejection settles', async () => {
    const failure = new Error('transient relay failure')
    mux.request.mockRejectedValueOnce(failure)

    const firstBurst = Array.from({ length: 8 }, () =>
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    )

    await expect(Promise.all(firstBurst)).rejects.toThrow('transient relay failure')
    expect(mux.request).toHaveBeenCalledTimes(1)

    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValueOnce(diff)

    await expect(provider.getDiff('/home/user/repo', 'src/file.ts', false, true)).resolves.toBe(
      diff
    )
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('clears pending diff RPCs when status runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
    await provider.getStatus('/home/user/repo')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending diff RPCs when submodule status runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
    await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending diff RPCs when a mutation runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce(undefined)
    await provider.stageFile('/home/user/repo', 'src/file.ts')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending branch diff RPCs when a ref-moving provider operation runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue([diff])
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getBranchDiff('/home/user/repo', 'origin/main', {
      includePatch: true,
      filePath: 'src/file.ts'
    })
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce(undefined)
    await provider.fetchRemoteTrackingRef(
      '/home/user/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )

    mux.request.mockResolvedValueOnce([diff])
    const second = provider.getBranchDiff('/home/user/repo', 'origin/main', {
      includePatch: true,
      filePath: 'src/file.ts'
    })

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([[diff], [diff]])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('coalesces logically identical branch and commit diff RPC args regardless of property order', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValue([diff])

    await Promise.all([
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        includePatch: true
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(1)

    mux.request.mockReset()
    mux.request.mockResolvedValue(diff)

    await Promise.all([
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        parentOid: 'b'.repeat(40),
        commitOid: 'c'.repeat(40)
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct diff RPC keys independent', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValue(diff)

    await Promise.all([
      provider.getDiff('/home/user/repo', 'src/file.ts', false, false),
      provider.getDiff('/home/user/repo', 'src/file.ts', true, false),
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: false,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'develop', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'a'.repeat(40),
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(10)
  })

  it('listWorktrees sends git.listWorktrees request', async () => {
    const worktrees = [
      {
        path: '/home/user/repo',
        head: 'abc123',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ]
    mux.request.mockResolvedValue(worktrees)

    const controller = new AbortController()
    const result = await provider.listWorktrees('/home/user/repo', { signal: controller.signal })
    expect(mux.request).toHaveBeenCalledWith(
      'git.listWorktrees',
      { repoPath: '/home/user/repo' },
      { signal: controller.signal }
    )
    expect(result).toEqual(worktrees)
  })

  it('addWorktree sends git.addWorktree request', async () => {
    await provider.addWorktree('/home/user/repo', 'feature', '/home/user/feat', {
      base: 'main',
      noCheckout: true
    })
    expect(mux.request).toHaveBeenCalledWith('git.addWorktree', {
      repoPath: '/home/user/repo',
      branchName: 'feature',
      targetDir: '/home/user/feat',
      base: 'main',
      noCheckout: true
    })
  })

  it('removeWorktree sends git.removeWorktree request', async () => {
    await provider.removeWorktree('/home/user/feat', true)
    expect(mux.request).toHaveBeenCalledWith('git.removeWorktree', {
      worktreePath: '/home/user/feat',
      force: true
    })
  })

  it('worktreeIsClean sends git.worktreeIsClean request', async () => {
    const cleanResult = { clean: false, stdout: '?? scratch.txt\n' }
    mux.request.mockResolvedValue(cleanResult)

    const result = await provider.worktreeIsClean('/home/user/feat')

    expect(mux.request).toHaveBeenCalledWith('git.worktreeIsClean', {
      worktreePath: '/home/user/feat'
    })
    expect(result).toEqual(cleanResult)
  })

  it('worktreeIsClean can ignore untracked files', async () => {
    const cleanResult = { clean: true }
    mux.request.mockResolvedValue(cleanResult)

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(mux.request).toHaveBeenCalledWith('git.worktreeIsClean', {
      worktreePath: '/home/user/feat',
      includeUntracked: false
    })
    expect(result).toEqual(cleanResult)
  })

  it('worktreeIsClean filters untracked stdout when old relays ignore the option', async () => {
    mux.request.mockResolvedValue({ clean: false, stdout: '?? scratch.txt\n' })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: true })
  })

  it('worktreeIsClean keeps dirty results without stdout dirty for tracked-only checks', async () => {
    mux.request.mockResolvedValue({ clean: false })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: false })
  })

  it('refreshLocalBaseRefForWorktreeCreate sends the narrow refresh request', async () => {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath: '/home/user/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/home/user/repo'
    })

    expect(mux.request).toHaveBeenCalledWith('git.refreshLocalBaseRefForWorktreeCreate', {
      repoPath: '/home/user/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      ownerWorktreePath: '/home/user/repo'
    })
  })

  it('worktreeIsClean falls back to git.status for old relays', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await provider.worktreeIsClean('/home/user/feat')

      expect(mux.request).toHaveBeenNthCalledWith(1, 'git.worktreeIsClean', {
        worktreePath: '/home/user/feat'
      })
      expect(mux.request).toHaveBeenNthCalledWith(2, 'git.status', {
        worktreePath: '/home/user/feat'
      })
      expect(result).toEqual({ clean: false, stdout: 'untracked untracked: scratch.txt' })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('worktreeIsClean filters untracked entries in old-relay fallback', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(
        provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })
      ).resolves.toEqual({ clean: true })
      expect(mux.request).toHaveBeenNthCalledWith(2, 'git.status', {
        worktreePath: '/home/user/feat'
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('renameCurrentBranch sends the narrow branch-rename request', async () => {
    await provider.renameCurrentBranch('/home/user/feat', 'you/fix-auth')
    expect(mux.request).toHaveBeenCalledWith('git.renameCurrentBranch', {
      worktreePath: '/home/user/feat',
      newBranch: 'you/fix-auth'
    })
  })

  it('forceDeletePreservedBranch sends the preserved-branch delete request', async () => {
    await provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    expect(mux.request).toHaveBeenCalledWith('git.forceDeletePreservedBranch', {
      repoPath: '/home/user/repo',
      branchName: 'you/fix-auth',
      expectedHead: 'abc123'
    })
  })

  it('forceDeletePreservedBranch maps old relays to the reconnect message', async () => {
    const methodNotFound = Object.assign(
      new Error('Method not found: git.forceDeletePreservedBranch'),
      { code: -32601 }
    )
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot delete preserved branches. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('forceDeletePreservedBranch rethrows non-method-not-found errors', async () => {
    const error = new Error('remote update-ref failed')
    mux.request.mockRejectedValueOnce(error)

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toBe(error)
  })

  it('isGitRepo always returns true for remote paths', () => {
    expect(provider.isGitRepo('/any/path')).toBe(true)
  })
})
