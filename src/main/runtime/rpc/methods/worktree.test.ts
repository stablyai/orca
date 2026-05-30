import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree RPC methods', () => {
  it('routes create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        branchNameOverride: 'feature/something',
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        displayName: 'Feature title',
        telemetrySource: 'sidebar',
        workspaceStatus: 'in-review',
        manualOrder: 123_456,
        linkedIssue: 123,
        linkedPR: 456,
        linkedGitLabIssue: 789,
        linkedGitLabMR: 321,
        sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
        pushTarget: { remoteName: 'fork', branchName: 'feature' },
        parentWorktree: 'id:parent'
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'repo-1',
      name: 'feature',
      branchNameOverride: 'feature/something',
      baseBranch: 'origin/main',
      linkedIssue: 123,
      linkedPR: 456,
      linkedLinearIssue: undefined,
      linkedGitLabIssue: 789,
      linkedGitLabMR: 321,
      comment: undefined,
      displayName: 'Feature title',
      telemetrySource: 'sidebar',
      workspaceStatus: 'in-review',
      manualOrder: 123_456,
      sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
      pushTarget: { remoteName: 'fork', branchName: 'feature' },
      runHooks: false,
      activate: false,
      setupDecision: 'skip',
      createdWithAgent: undefined,
      startup: undefined,
      startupDraft: undefined,
      lineage: {
        parentWorktree: 'id:parent',
        noParent: false,
        callerTerminalHandle: undefined,
        orchestrationContext: undefined
      }
    })
  })

  it('forwards startup command and env to runtime worktree creation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-startup',
        startupCommand: "codex 'summarize repo'",
        startupEnv: { ORCA_AGENT_MODE: 'direct' },
        activate: true
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'agent-startup',
        activate: true,
        startup: {
          command: "codex 'summarize repo'",
          env: { ORCA_AGENT_MODE: 'direct' }
        }
      })
    )
  })

  it('forwards task startup drafts to runtime worktree creation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'issue-123',
        startupDraft: 'https://github.com/stablyai/orca/issues/123',
        createdWithAgent: 'codex',
        activate: true
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'issue-123',
        activate: true,
        createdWithAgent: 'codex',
        startup: undefined,
        startupDraft: 'https://github.com/stablyai/orca/issues/123'
      })
    )
  })

  it('maps unknown telemetry sources to the runtime default instead of rejecting create', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        telemetrySource: 'future_surface'
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'feature',
        telemetrySource: undefined
      })
    )
  })

  it('rejects worktree.create when both parent and no-parent are supplied', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'child',
        parentWorktree: 'id:parent',
        noParent: true
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('Choose either --parent-worktree or --no-parent')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('passes explicit repo selectors to PR base resolution', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveManagedPrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/pr-head' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.resolvePrBase', {
        repo: 'id:repo-1',
        prNumber: 42,
        headRefName: 'feature/pr-head',
        isCrossRepository: false
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.resolveManagedPrBase).toHaveBeenCalledWith({
      repoSelector: 'id:repo-1',
      prNumber: 42,
      headRefName: 'feature/pr-head',
      isCrossRepository: false
    })
  })

  it('passes explicit repo selectors to MR base resolution', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveManagedMrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/mr-head' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.resolveMrBase', {
        repo: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'feature/mr-head',
        isCrossRepository: false
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.resolveManagedMrBase).toHaveBeenCalledWith({
      repoSelector: 'id:repo-1',
      mrIid: 42,
      sourceBranch: 'feature/mr-head',
      isCrossRepository: false
    })
  })

  it('rejects worktree.set when both parent and no-parent are supplied', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', {
        worktree: 'id:child',
        parentWorktree: 'id:parent',
        noParent: true
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('Choose either --parent-worktree or --no-parent')
    expect(runtime.updateManagedWorktreeMeta).not.toHaveBeenCalled()
  })

  it('lists raw worktree lineage through the runtime server', async () => {
    const lineage = {
      'repo::/child': {
        worktreeId: 'repo::/child',
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'repo::/missing-parent',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listWorktreeLineage: vi.fn().mockResolvedValue(lineage)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('worktree.lineageList'))

    expect(runtime.listWorktreeLineage).toHaveBeenCalled()
    expect(response).toMatchObject({ ok: true, result: { lineage } })
  })

  it('persists smart sort order on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      persistManagedWorktreeSortOrder: vi.fn().mockReturnValue({ updated: 2 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.persistSortOrder', { orderedIds: ['wt-1', 'wt-2'] })
    )

    expect(runtime.persistManagedWorktreeSortOrder).toHaveBeenCalledWith(['wt-1', 'wt-2'])
    expect(response).toMatchObject({ ok: true, result: { updated: 2 } })
  })
})
