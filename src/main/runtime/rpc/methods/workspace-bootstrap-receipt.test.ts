import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT } from '../../../../shared/workspace-bootstrap-receipt'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext } from '../core'
import {
  issueWorkspaceBootstrapReceipt,
  requireCoordinatorWorkspace,
  requireWorkspaceBootstrapCoordinator
} from './workspace-bootstrap-receipt'

const HEAD = 'a'.repeat(40)

type ResolvedWorkspace = { id: string; repoId: string; path: string; hostId: string }

function runtimeWith(
  workspaces: Record<string, ResolvedWorkspace>,
  status: { head: string | null; entries: { path: string }[] } | (() => never)
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(async (selector) => {
    const workspace = workspaces[selector]
    if (!workspace) {
      throw new Error(`selector_not_found: ${selector}`)
    }
    return workspace as never
  })
  vi.spyOn(runtime, 'getRuntimeGitStatus').mockImplementation(async () => {
    if (typeof status === 'function') {
      return status()
    }
    return status as never
  })
  return runtime
}

const home: ResolvedWorkspace = {
  id: 'folder:home-1',
  repoId: 'folder-workspace:group-1',
  path: '/workspace/home',
  hostId: 'local'
}

function request(overrides: Partial<Parameters<typeof issueWorkspaceBootstrapReceipt>[1]> = {}) {
  return {
    runId: 'run-1',
    orchestrationHomeSelector: 'id:home',
    executionWorkspaceSelector: 'id:home',
    executionHostId: 'local',
    ...overrides
  }
}

describe('issueWorkspaceBootstrapReceipt', () => {
  it('accepts the reserved successor before Run authority is committed', () => {
    const runtime = new OrcaRuntimeService()
    const database = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(database)
    const run = database.createRun({
      objective: 'bootstrap current coordinator',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const handoff = database.reserveCoordinatorHandoff({
      requestId: 'handoff-bootstrap',
      runId: run.id,
      executionHostId: 'local',
      workspaceKey: 'folder:home-1',
      title: 'Harness · coordinator g2 · Codex',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'yolo',
        routeRef: null
      },
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'coordinator:g2',
      capsuleDigest: `sha256:${'a'.repeat(64)}`,
      inputIdempotencyKey: 'handoff-bootstrap:input',
      expectedGraphRevision: 0,
      retentionPolicy: 'retain'
    })
    database.attachMaestroTerminalLease({
      leaseId: handoff.successorLeaseId,
      terminalHandle: 'coordinator-2',
      tabId: 'tab-2',
      paneKey: 'tab-2:leaf-2',
      ptyIncarnation: 'pty-2:incarnation-1',
      processRootId: 'pty-2'
    })
    database.transitionMaestroTerminalLease({
      leaseId: handoff.successorLeaseId,
      state: 'ready'
    })
    database.advanceCoordinatorHandoff({
      requestId: handoff.requestId,
      phase: 'spawned',
      terminalHandle: 'coordinator-2',
      tabId: 'tab-2',
      ptyIncarnation: 'pty-2:incarnation-1'
    })
    const evidence = {
      terminalHandle: 'coordinator-2',
      paneKey: 'tab-2:leaf-2',
      launchToken: 'launch-token'
    }
    const verify = vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' },
      terminalHandle: 'coordinator-2',
      paneKey: 'tab-2:leaf-2',
      processIncarnation: 'pty-2:incarnation-1',
      launchTokenHash: 'hash-1'
    })

    const coordinator = requireWorkspaceBootstrapCoordinator(
      { runtime, orchestrationCompatibilityEvidence: evidence } as RpcContext,
      run.id
    )

    expect(coordinator).toMatchObject({
      terminalHandle: 'coordinator-2',
      paneKey: 'tab-2:leaf-2'
    })
    expect(database.getRun(run.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      consumer_generation: run.consumer_generation + 1
    })
    expect(verify).toHaveBeenCalledExactlyOnceWith(evidence, {
      currentRuntimeLaunchSufficient: true
    })
    database.close()
  })

  it('canonicalizes a raw Git terminal ID when checking coordinator workspace authority', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'coordinator-1',
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'repo-1::/workspace/repo'
    } as never)

    expect(() =>
      requireCoordinatorWorkspace(
        runtime,
        {
          terminalHandle: 'coordinator-1',
          paneKey: 'tab-1:leaf-1'
        },
        'worktree:repo-1::/workspace/repo'
      )
    ).not.toThrow()
  })

  it('rejects a request with no validated Run ID', async () => {
    const runtime = runtimeWith({}, { head: HEAD, entries: [] })
    await expect(issueWorkspaceBootstrapReceipt(runtime, request({ runId: '' }))).rejects.toThrow(
      'validated run ID'
    )
  })

  it('issues a folder observation without probing Git or inventing dirty state', async () => {
    const runtime = runtimeWith({ 'id:home': home }, { head: HEAD, entries: [] })

    const receipt = await issueWorkspaceBootstrapReceipt(runtime, request())

    expect(receipt).toMatchObject({
      schema_version: 2,
      repository_id: 'home-1',
      canonical_root: '/workspace/home',
      execution_host: { id: 'local', boundary: 'local' },
      orchestration_home: {
        kind: 'folder',
        workspace_key: 'folder:home-1',
        path: '/workspace/home'
      },
      execution_workspace: {
        kind: 'folder',
        workspace_key: 'folder:home-1',
        path: '/workspace/home'
      },
      base_revision_kind: 'folder_observation',
      dirty_state: 'not_applicable',
      dirty_path_count: 0,
      dirty_paths: [],
      dirty_paths_truncated: false,
      authority: { kind: 'orca', scope: 'run', issued_for_run_id: 'run-1' }
    })
    expect(receipt.base_revision).toMatch(/^folder-observation:/)
    expect(runtime.getRuntimeGitStatus).not.toHaveBeenCalled()
  })

  it('observes exact local Git HEAD and deterministic bounded dirty evidence', async () => {
    const dirtyPaths = Array.from(
      { length: WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT + 2 },
      (_, index) => `src/${String(index).padStart(3, '0')}.ts`
    ).toReversed()
    const runtime = runtimeWith(
      {
        'id:home': home,
        'id:work': {
          id: 'repo-1::/workspace/repo',
          repoId: 'repo-1',
          path: '/workspace/repo',
          hostId: 'local'
        }
      },
      { head: HEAD, entries: [...dirtyPaths.map((path) => ({ path })), { path: dirtyPaths[0] }] }
    )

    const receipt = await issueWorkspaceBootstrapReceipt(
      runtime,
      request({ executionWorkspaceSelector: 'id:work' })
    )

    expect(receipt).toMatchObject({
      base_revision_kind: 'git_head',
      base_revision: HEAD,
      dirty_state: 'dirty',
      dirty_path_count: WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT + 2,
      dirty_paths_truncated: true,
      execution_workspace: {
        kind: 'git-worktree',
        workspace_key: 'worktree:repo-1::/workspace/repo',
        worktree_path: '/workspace/repo'
      }
    })
    expect(receipt.dirty_paths).toHaveLength(WORKSPACE_BOOTSTRAP_DIRTY_PATH_SAMPLE_LIMIT)
    expect(receipt.dirty_paths).toEqual([...receipt.dirty_paths].sort())
    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledExactlyOnceWith(
      'id:repo-1::/workspace/repo'
    )
  })

  it('uses the remote execution host for Git evidence and preserves the local home', async () => {
    const runtime = runtimeWith(
      {
        'id:home': home,
        'id:remote': {
          id: 'repo-2::/srv/repo',
          repoId: 'repo-2',
          path: '/srv/repo',
          hostId: 'ssh:target-1'
        }
      },
      { head: 'b'.repeat(40), entries: [{ path: 'src/index.ts' }] }
    )

    const receipt = await issueWorkspaceBootstrapReceipt(
      runtime,
      request({
        executionWorkspaceSelector: 'id:remote',
        executionHostId: 'ssh:target-1'
      })
    )

    expect(receipt.execution_host).toEqual({ id: 'ssh:target-1', boundary: 'remote' })
    expect(receipt.orchestration_home.workspace_key).toBe('folder:home-1')
    expect(receipt.execution_workspace.workspace_key).toBe('worktree:repo-2::/srv/repo')
    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledExactlyOnceWith('id:repo-2::/srv/repo')
  })

  it('rejects a mismatched execution host before observing Git', async () => {
    const runtime = runtimeWith(
      {
        'id:home': home,
        'id:remote': {
          id: 'repo-2::/srv/repo',
          repoId: 'repo-2',
          path: '/srv/repo',
          hostId: 'ssh:target-1'
        }
      },
      { head: HEAD, entries: [] }
    )

    await expect(
      issueWorkspaceBootstrapReceipt(
        runtime,
        request({ executionWorkspaceSelector: 'id:remote', executionHostId: 'ssh:other' })
      )
    ).rejects.toThrow('Execution host mismatch')
    expect(runtime.getRuntimeGitStatus).not.toHaveBeenCalled()
  })

  it('fails typed when Git evidence is unavailable and snapshots an unborn repository', async () => {
    const gitWorkspace = {
      id: 'repo-1::/workspace/repo',
      repoId: 'repo-1',
      path: '/workspace/repo',
      hostId: 'local'
    }
    const unavailable = runtimeWith({ 'id:home': home, 'id:work': gitWorkspace }, () => {
      throw new Error('SSH Git provider is unavailable')
    })
    await expect(
      issueWorkspaceBootstrapReceipt(
        unavailable,
        request({ executionWorkspaceSelector: 'id:work' })
      )
    ).rejects.toThrow('Could not observe Git status')

    const unborn = runtimeWith(
      { 'id:home': home, 'id:work': gitWorkspace },
      { head: null, entries: [] }
    )
    await expect(
      issueWorkspaceBootstrapReceipt(unborn, request({ executionWorkspaceSelector: 'id:work' }))
    ).resolves.toMatchObject({
      schema_version: 2,
      base_revision_kind: 'git_head',
      base_revision: '0'.repeat(40),
      dirty_state: 'clean'
    })
  })
})
