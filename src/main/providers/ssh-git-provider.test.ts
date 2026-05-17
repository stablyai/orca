import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
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
      cwd: '/home/user/repo'
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
      timeoutMs: 60_000
    })
    expect(result).toEqual(execResult)
  })

  it('cancelGenerateCommitMessage sends best-effort relay cancellation', async () => {
    await provider.cancelGenerateCommitMessage('/home/user/repo')

    expect(mux.request).toHaveBeenCalledWith('agent.cancelExec', { cwd: '/home/user/repo' })
  })

  it('getDiff sends git.diff request', async () => {
    const diffResult = { kind: 'text', originalContent: '', modifiedContent: 'hello' }
    mux.request.mockResolvedValue(diffResult)

    const result = await provider.getDiff('/home/user/repo', 'src/index.ts', true)
    expect(mux.request).toHaveBeenCalledWith('git.diff', {
      worktreePath: '/home/user/repo',
      filePath: 'src/index.ts',
      staged: true
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

  it('pullBranch sends git.pull request', async () => {
    await provider.pullBranch('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.pull', {
      worktreePath: '/home/user/repo'
    })
  })

  it('fetchRemote sends git.fetch request', async () => {
    await provider.fetchRemote('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.fetch', {
      worktreePath: '/home/user/repo'
    })
  })

  it('getBranchDiff sends git.branchDiff request', async () => {
    const diffs = [{ kind: 'text', originalContent: '', modifiedContent: 'new' }]
    mux.request.mockResolvedValue(diffs)

    const result = await provider.getBranchDiff('/home/user/repo', 'main')
    expect(mux.request).toHaveBeenCalledWith('git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main'
    })
    expect(result).toEqual(diffs)
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
    await provider.addWorktree('/home/user/repo', 'feature', '/home/user/feat', { base: 'main' })
    expect(mux.request).toHaveBeenCalledWith('git.addWorktree', {
      repoPath: '/home/user/repo',
      branchName: 'feature',
      targetDir: '/home/user/feat',
      base: 'main'
    })
  })

  it('removeWorktree sends git.removeWorktree request', async () => {
    await provider.removeWorktree('/home/user/feat', true)
    expect(mux.request).toHaveBeenCalledWith('git.removeWorktree', {
      worktreePath: '/home/user/feat',
      force: true
    })
  })

  it('isGitRepo always returns true for remote paths', () => {
    expect(provider.isGitRepo('/any/path')).toBe(true)
  })
})
