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

// worktree.create routes through the runtime's clientMutationId idempotency
// wrapper; these unit mocks run the create straight through (no dedupe).
const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('worktree.create automation provenance', () => {
  it('mints automation provenance from a valid dispatch request on worktree creation', async () => {
    const dispatchToken = createAutomationDispatchToken('automation-1', 'run-1')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
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
      dedupeWorktreeCreate: passthroughDedupe,
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
      dedupeWorktreeCreate: passthroughDedupe,
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
      dedupeWorktreeCreate: passthroughDedupe,
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
      dedupeWorktreeCreate: passthroughDedupe,
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
})
