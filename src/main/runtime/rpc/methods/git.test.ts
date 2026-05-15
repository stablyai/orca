import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GIT_METHODS } from './git'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('git RPC methods', () => {
  it('returns status for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitStatus: vi.fn().mockResolvedValue({
        entries: [],
        conflictOperation: 'unknown',
        branch: 'main',
        head: 'abc'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(makeRequest('git.status', { worktree: 'id:wt-1' }))

    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledWith('id:wt-1')
    expect(response).toMatchObject({
      ok: true,
      result: { entries: [], branch: 'main' }
    })
  })

  it('forwards includeIgnored for status requests', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitStatus: vi.fn().mockResolvedValue({
        entries: [],
        conflictOperation: 'unknown',
        ignoredPaths: ['dist/']
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.status', { worktree: 'id:wt-1', includeIgnored: true })
    )

    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledWith('id:wt-1', {
      includeIgnored: true
    })
    expect(response).toMatchObject({
      ok: true,
      result: { ignoredPaths: ['dist/'] }
    })
  })

  it('returns a worktree file diff', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitDiff: vi.fn().mockResolvedValue({
        kind: 'text',
        originalContent: '',
        modifiedContent: 'hello',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.diff', {
        worktree: 'id:wt-1',
        filePath: 'src/index.ts',
        staged: false,
        compareAgainstHead: true
      })
    )

    expect(runtime.getRuntimeGitDiff).toHaveBeenCalledWith('id:wt-1', 'src/index.ts', false, true)
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'text', modifiedContent: 'hello' }
    })
  })

  it('returns bounded git history for a selected worktree', async () => {
    const history = {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitHistory: vi.fn().mockResolvedValue(history)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.history', {
        worktree: 'id:wt-1',
        limit: 25,
        baseRef: 'origin/main'
      })
    )

    expect(runtime.getRuntimeGitHistory).toHaveBeenCalledWith('id:wt-1', {
      limit: 25,
      baseRef: 'origin/main'
    })
    expect(response).toMatchObject({ ok: true, result: history })
  })

  it('routes common mutations to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      stageRuntimeGitPath: vi.fn().mockResolvedValue({ ok: true }),
      bulkUnstageRuntimeGitPaths: vi.fn().mockResolvedValue({ ok: true }),
      discardRuntimeGitPath: vi.fn().mockResolvedValue({ ok: true }),
      bulkDiscardRuntimeGitPaths: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    await dispatcher.dispatch(
      makeRequest('git.stage', { worktree: 'id:wt-1', filePath: 'src/a.ts' })
    )
    await dispatcher.dispatch(
      makeRequest('git.bulkUnstage', { worktree: 'id:wt-1', filePaths: ['src/a.ts', 'b.ts'] })
    )
    await dispatcher.dispatch(
      makeRequest('git.discard', { worktree: 'id:wt-1', filePath: 'src/a.ts' })
    )
    await dispatcher.dispatch(
      makeRequest('git.bulkDiscard', { worktree: 'id:wt-1', filePaths: ['src/a.ts', 'b.ts'] })
    )

    expect(runtime.stageRuntimeGitPath).toHaveBeenCalledWith('id:wt-1', 'src/a.ts')
    expect(runtime.bulkUnstageRuntimeGitPaths).toHaveBeenCalledWith('id:wt-1', ['src/a.ts', 'b.ts'])
    expect(runtime.discardRuntimeGitPath).toHaveBeenCalledWith('id:wt-1', 'src/a.ts')
    expect(runtime.bulkDiscardRuntimeGitPaths).toHaveBeenCalledWith('id:wt-1', ['src/a.ts', 'b.ts'])
  })

  it('rejects empty bulk mutation paths before calling the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bulkDiscardRuntimeGitPaths: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.bulkDiscard', { worktree: 'id:wt-1', filePaths: [''] })
    )

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({
      error: expect.objectContaining({ code: 'invalid_argument' })
    })
    expect(runtime.bulkDiscardRuntimeGitPaths).not.toHaveBeenCalled()
  })

  it('routes remote operations to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      commitRuntimeGit: vi.fn().mockResolvedValue({ success: true }),
      generateRuntimeCommitMessage: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'feat: test' }),
      cancelRuntimeGenerateCommitMessage: vi.fn().mockResolvedValue({ ok: true }),
      pushRuntimeGit: vi.fn().mockResolvedValue({ ok: true }),
      getRuntimeGitRemoteFileUrl: vi.fn().mockResolvedValue('https://example.com/file#L3')
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    await dispatcher.dispatch(
      makeRequest('git.commit', { worktree: 'id:wt-1', message: 'feat: test' })
    )
    await dispatcher.dispatch(makeRequest('git.generateCommitMessage', { worktree: 'id:wt-1' }))
    await dispatcher.dispatch(
      makeRequest('git.cancelGenerateCommitMessage', { worktree: 'id:wt-1' })
    )
    await dispatcher.dispatch(
      makeRequest('git.push', {
        worktree: 'id:wt-1',
        publish: true,
        pushTarget: { remote: 'origin' }
      })
    )
    const response = await dispatcher.dispatch(
      makeRequest('git.remoteFileUrl', {
        worktree: 'id:wt-1',
        relativePath: 'src/a.ts',
        line: 3
      })
    )

    expect(runtime.commitRuntimeGit).toHaveBeenCalledWith('id:wt-1', 'feat: test')
    expect(runtime.generateRuntimeCommitMessage).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.cancelRuntimeGenerateCommitMessage).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.pushRuntimeGit).toHaveBeenCalledWith('id:wt-1', true, { remote: 'origin' })
    expect(response).toMatchObject({ ok: true, result: 'https://example.com/file#L3' })
  })

  it('forwards commit-message settings to the runtime', async () => {
    const commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.3-codex-spark' },
      selectedThinkingByModel: { 'gpt-5.3-codex-spark': 'medium' },
      customPrompt: '',
      customAgentCommand: ''
    }
    const agentCmdOverrides = { codex: 'codex --profile work' }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      generateRuntimeCommitMessage: vi.fn().mockResolvedValue({ success: true, message: 'test' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    await dispatcher.dispatch(
      makeRequest('git.generateCommitMessage', {
        worktree: 'id:wt-1',
        commitMessageAi,
        agentCmdOverrides,
        enableGitHubAttribution: true
      })
    )

    expect(runtime.generateRuntimeCommitMessage).toHaveBeenCalledWith('id:wt-1', {
      commitMessageAi,
      agentCmdOverrides,
      enableGitHubAttribution: true
    })
  })

  it('rejects malformed commit-message settings before calling the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      generateRuntimeCommitMessage: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.generateCommitMessage', {
        worktree: 'id:wt-1',
        commitMessageAi: {
          enabled: true,
          agentId: 'codex'
        }
      })
    )

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({
      error: expect.objectContaining({ code: 'invalid_argument' })
    })
    expect(runtime.generateRuntimeCommitMessage).not.toHaveBeenCalled()
  })

  it('rejects branch diff revisions that are not full object ids', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBranchDiff: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.branchDiff', {
        worktree: 'id:wt-1',
        filePath: 'src/a.ts',
        compare: {
          headOid: '--output=/tmp/orca-test',
          mergeBase: 'a'.repeat(40)
        }
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.getRuntimeGitBranchDiff).not.toHaveBeenCalled()
  })

  it('rejects branch compare refs that look like git options', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBranchCompare: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.branchCompare', {
        worktree: 'id:wt-1',
        baseRef: '--output=/tmp/orca-test'
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
  })

  it('rejects git history limits above the runtime cap', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitHistory: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.history', {
        worktree: 'id:wt-1',
        limit: 201
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.getRuntimeGitHistory).not.toHaveBeenCalled()
  })
})
