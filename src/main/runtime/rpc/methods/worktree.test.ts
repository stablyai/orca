import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const,
  executionHostId: 'ssh:ssh-target-1' as const
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// worktree.create routes through the runtime's clientMutationId idempotency
// wrapper; these unit mocks run the create straight through (no dedupe).
const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('worktree RPC methods', () => {
  it('routes mobile session-only activation without notifying desktop clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      activateManagedWorktree: vi
        .fn()
        .mockResolvedValue({ repoId: 'repo-1', worktreeId: 'wt-1', activated: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.activate', {
        worktree: 'id:wt-1',
        notifyClients: false
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.activateManagedWorktree).toHaveBeenCalledWith('id:wt-1', {
      notifyClients: false,
      clientKind: undefined,
      navigation: 'caller'
    })
  })

  it('forwards the mobile clientKind to the runtime on session-only activation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      activateManagedWorktree: vi
        .fn()
        .mockResolvedValue({ repoId: 'repo-1', worktreeId: 'wt-1', activated: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    // The mobile WebSocket path always uses dispatchStreaming, which threads the
    // authenticated device scope as clientKind even for non-streaming methods.
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      makeRequest('worktree.activate', { worktree: 'id:wt-1', notifyClients: false }),
      (response) => replies.push(response),
      { clientKind: 'mobile' }
    )

    expect(runtime.activateManagedWorktree).toHaveBeenCalledWith('id:wt-1', {
      notifyClients: false,
      clientKind: 'mobile',
      navigation: 'caller'
    })
  })

  it('routes create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        branchNameOverride: 'feature/something',
        baseBranch: 'origin/main',
        compareBaseRef: undefined,
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
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      linkedGitLabIssue: 789,
      linkedGitLabMR: 321,
      linkedBitbucketPR: undefined,
      linkedAzureDevOpsPR: undefined,
      linkedGiteaPR: undefined,
      comment: undefined,
      displayName: 'Feature title',
      telemetrySource: 'sidebar',
      workspaceStatus: 'in-review',
      manualOrder: 123_456,
      sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
      pushTarget: { remoteName: 'fork', branchName: 'feature' },
      runHooks: false,
      activate: false,
      navigation: 'all',
      setupDecision: 'skip',
      createdWithAgent: undefined,
      automationProvenance: undefined,
      creatorProvenance: { kind: 'host' },
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
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({
        worktree: { id: 'wt-1' },
        startupTerminal: { spawned: true, handle: 'term_agent' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-startup',
        startupAgent: 'codex',
        startupCommand: "codex 'summarize repo'",
        startupCommandDelivery: 'shell-ready',
        startupEnv: { ORCA_AGENT_MODE: 'direct' },
        startupLaunchConfig: {
          agentCommand: 'codex',
          agentArgs: '--model gpt-5',
          agentEnv: { ORCA_AGENT_MODE: 'direct' }
        },
        activate: true
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { agentTerminalHandle: 'term_agent' }
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'agent-startup',
        activate: true,
        startupAgent: 'codex',
        startup: {
          command: "codex 'summarize repo'",
          startupCommandDelivery: 'shell-ready',
          env: { ORCA_AGENT_MODE: 'direct' },
          launchConfig: {
            agentCommand: 'codex',
            agentArgs: '--model gpt-5',
            agentEnv: { ORCA_AGENT_MODE: 'direct' }
          }
        }
      })
    )
  })

  it('returns agentTerminalHandle for a host-resolved agentLaunch create', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({
        worktree: { id: 'wt-1' },
        startupTerminal: { spawned: true, handle: 'term_agent' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-launch-create',
        agentLaunch: { selection: { kind: 'agent', agent: 'codex' }, prompt: 'summarize repo' },
        activate: true
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { agentTerminalHandle: 'term_agent' }
    })
  })

  it('drops invalid startup launch config env at the runtime RPC boundary', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-startup',
        startupCommand: "codex 'summarize repo'",
        startupLaunchConfig: {
          agentCommand: 'codex',
          agentArgs: '--model gpt-5',
          agentEnv: { ['__proto__']: 'polluted' }
        }
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startup: expect.objectContaining({
          command: "codex 'summarize repo'"
        })
      })
    )
    expect(vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0].startup).not.toHaveProperty(
      'launchConfig'
    )
  })

  it('forwards task startup drafts to runtime worktree creation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
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

  it('routes create-base prefetches to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      prefetchManagedWorktreeCreateBase: vi.fn().mockResolvedValue(undefined)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.prefetchCreateBase', {
        repo: 'repo-1',
        baseBranch: 'origin/main'
      })
    )

    expect(response).toMatchObject({ ok: true, result: null })
    expect(runtime.prefetchManagedWorktreeCreateBase).toHaveBeenCalledWith({
      repoSelector: 'repo-1',
      baseBranch: 'origin/main'
    })
  })

  it('maps unknown telemetry sources to the runtime default instead of rejecting create', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
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
      dedupeWorktreeCreate: passthroughDedupe,
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
    expect(JSON.stringify(response)).toContain('Choose either one parent selector or --no-parent')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('passes explicit repo selectors to PR base resolution and preserves start-point fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      resolveManagedPrBase: vi.fn().mockResolvedValue({
        baseBranch: 'abc123',
        headSha: 'abc123',
        branchNameOverride: 'feature/pr-head',
        pushTarget: { remoteName: 'origin', branchName: 'feature/pr-head' }
      })
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
    expect(response).toMatchObject({
      result: {
        baseBranch: 'abc123',
        headSha: 'abc123',
        branchNameOverride: 'feature/pr-head',
        pushTarget: { remoteName: 'origin', branchName: 'feature/pr-head' }
      }
    })
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
      dedupeWorktreeCreate: passthroughDedupe,
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

  it('forwards Linear metadata through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', {
        worktree: 'id:wt-1',
        linkedLinearIssue: 'STA-335',
        linkedLinearIssueWorkspaceId: null,
        linkedLinearIssueOrganizationUrlKey: 'stably'
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        linkedLinearIssue: 'STA-335',
        linkedLinearIssueWorkspaceId: null,
        linkedLinearIssueOrganizationUrlKey: 'stably'
      })
    )
  })

  it('forwards push target clears through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', {
        worktree: 'id:wt-1',
        linkedPR: null,
        pushTarget: null
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        linkedPR: null,
        pushTarget: null
      })
    )
  })

  it('rejects worktree.set when both parent and no-parent are supplied', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
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
      dedupeWorktreeCreate: passthroughDedupe,
      listWorktreeLineage: vi.fn().mockResolvedValue(lineage),
      listWorkspaceLineage: vi.fn().mockResolvedValue({})
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('worktree.lineageList'))

    expect(runtime.listWorktreeLineage).toHaveBeenCalled()
    expect(runtime.listWorkspaceLineage).toHaveBeenCalled()
    expect(response).toMatchObject({ ok: true, result: { lineage, workspaceLineage: {} } })
  })

  it('persists smart sort order on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
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
