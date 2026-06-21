import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { createAutomationDispatchToken } from '../../../automations/dispatch-tokens'

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

describe('worktree RPC methods', () => {
  it('routes create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
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
      setupDecision: 'skip',
      createdWithAgent: undefined,
      automationProvenance: undefined,
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

  it('mints automation provenance from a valid dispatch request on worktree creation', async () => {
    const dispatchToken = createAutomationDispatchToken('automation-1', 'run-1')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(repo),
      showAutomation: vi.fn(() => ({
        id: 'automation-1',
        name: 'Nightly review',
        projectId: 'legacy-repo-1',
        runContext: {
          projectId: 'project-1',
          repoId: 'repo-1',
          hostId: 'ssh:ssh-target-1'
        },
        workspaceMode: 'new_per_run',
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-target-1'
      })),
      listAutomationRuns: vi.fn(() => [
        {
          id: 'run-1',
          automationId: 'automation-1',
          title: 'Nightly review run',
          status: 'dispatching',
          workspaceId: null
        }
      ]),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'automation-workspace',
        automationProvenanceRequest: {
          automationId: 'automation-1',
          automationRunId: 'run-1',
          dispatchToken,
          createRequestId: 'create-request-1'
        }
      })
    )

    expect(response).toMatchObject({ ok: true })
    const replay = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'automation-workspace-replay',
        automationProvenanceRequest: {
          automationId: 'automation-1',
          automationRunId: 'run-1',
          dispatchToken,
          createRequestId: 'create-request-1'
        }
      })
    )

    expect(replay).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'automation-workspace',
        automationProvenance: expect.objectContaining({
          kind: 'created-by-automation',
          automationId: 'automation-1',
          automationNameSnapshot: 'Nightly review',
          automationRunId: 'run-1',
          automationRunTitleSnapshot: 'Nightly review run',
          executionTargetType: 'ssh',
          executionTargetId: 'ssh-target-1',
          projectId: 'project-1',
          repoId: 'repo-1',
          hostId: 'ssh:ssh-target-1'
        })
      })
    )
  })

  it('stamps automation provenance with the persisted runtime host from run context', async () => {
    const dispatchToken = createAutomationDispatchToken('automation-runtime', 'run-runtime')
    const runtimeLocalRepo = {
      id: 'repo-runtime',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      kind: 'git' as const
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(runtimeLocalRepo),
      showAutomation: vi.fn(() => ({
        id: 'automation-runtime',
        name: 'Runtime review',
        projectId: 'legacy-repo-runtime',
        runContext: {
          projectId: 'project-runtime',
          repoId: 'repo-runtime',
          hostId: 'runtime:owner-runtime'
        },
        workspaceMode: 'new_per_run',
        executionTargetType: 'runtime',
        executionTargetId: 'owner-runtime'
      })),
      listAutomationRuns: vi.fn(() => [
        {
          id: 'run-runtime',
          automationId: 'automation-runtime',
          title: 'Runtime review run',
          status: 'dispatching',
          workspaceId: null
        }
      ]),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-runtime' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-runtime',
        name: 'runtime-automation-workspace',
        automationProvenanceRequest: {
          automationId: 'automation-runtime',
          automationRunId: 'run-runtime',
          dispatchToken,
          createRequestId: 'create-request-runtime'
        }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvenance: expect.objectContaining({
          automationId: 'automation-runtime',
          automationRunId: 'run-runtime',
          repoId: 'repo-runtime',
          hostId: 'runtime:owner-runtime'
        })
      })
    )
  })

  it('validates and stamps automation provenance from the dispatching run snapshot', async () => {
    const dispatchToken = createAutomationDispatchToken('automation-edited', 'run-edited')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(repo),
      showAutomation: vi.fn(() => ({
        id: 'automation-edited',
        name: 'Edited review',
        projectId: 'legacy-repo-edited',
        runContext: {
          projectId: 'project-after-edit',
          repoId: 'repo-after-edit',
          hostId: 'runtime:after-edit'
        },
        workspaceMode: 'new_per_run',
        executionTargetType: 'runtime',
        executionTargetId: 'after-edit'
      })),
      listAutomationRuns: vi.fn(() => [
        {
          id: 'run-edited',
          automationId: 'automation-edited',
          title: 'Pre-edit run',
          runContext: {
            projectId: 'project-before-edit',
            repoId: 'repo-1',
            hostId: 'runtime:before-edit'
          },
          status: 'dispatching',
          workspaceId: null
        }
      ]),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-edited' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'edited-automation-workspace',
        automationProvenanceRequest: {
          automationId: 'automation-edited',
          automationRunId: 'run-edited',
          dispatchToken,
          createRequestId: 'create-request-edited'
        }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvenance: expect.objectContaining({
          automationId: 'automation-edited',
          automationRunId: 'run-edited',
          projectId: 'project-before-edit',
          repoId: 'repo-1',
          hostId: 'runtime:before-edit'
        })
      })
    )
  })

  it('allows the same automation provenance request to retry after a failed create attempt', async () => {
    const dispatchToken = createAutomationDispatchToken('automation-retry', 'run-retry')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(repo),
      showAutomation: vi.fn(() => ({
        id: 'automation-retry',
        name: 'Nightly retry',
        projectId: 'repo-1',
        workspaceMode: 'new_per_run',
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-target-1'
      })),
      listAutomationRuns: vi.fn(() => [
        {
          id: 'run-retry',
          automationId: 'automation-retry',
          title: 'Nightly retry run',
          status: 'dispatching',
          workspaceId: null
        }
      ]),
      createManagedWorktree: vi
        .fn()
        .mockRejectedValueOnce(new Error('Branch "automation-workspace" already exists.'))
        .mockResolvedValueOnce({ worktree: { id: 'wt-retry' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const automationProvenanceRequest = {
      automationId: 'automation-retry',
      automationRunId: 'run-retry',
      dispatchToken,
      createRequestId: 'create-request-retry'
    }

    const firstResponse = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'automation-workspace',
        automationProvenanceRequest
      })
    )
    const retryResponse = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'automation-workspace-2',
        automationProvenanceRequest
      })
    )

    expect(firstResponse).toMatchObject({ ok: false })
    expect(retryResponse).toMatchObject({ ok: true })
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(2)
    expect(runtime.createManagedWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'automation-workspace-2',
        automationProvenance: expect.objectContaining({
          automationId: 'automation-retry',
          automationRunId: 'run-retry'
        })
      })
    )
  })

  it('rejects forged automation provenance requests on worktree creation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(repo),
      showAutomation: vi.fn(() => ({
        id: 'automation-1',
        name: 'Nightly review',
        projectId: 'repo-1',
        workspaceMode: 'new_per_run',
        executionTargetType: 'local',
        executionTargetId: 'local'
      })),
      listAutomationRuns: vi.fn(() => [
        {
          id: 'run-1',
          automationId: 'automation-1',
          title: 'Nightly review run',
          status: 'dispatching',
          workspaceId: null
        }
      ]),
      createManagedWorktree: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'manual-workspace',
        automationProvenanceRequest: {
          automationId: 'automation-1',
          automationRunId: 'run-1',
          dispatchToken: 'forged-token',
          createRequestId: 'create-request-forged'
        }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('forwards startup command and env to runtime worktree creation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-startup',
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

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'repo-1',
        name: 'agent-startup',
        activate: true,
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

  it('drops invalid startup launch config env at the runtime RPC boundary', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
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
