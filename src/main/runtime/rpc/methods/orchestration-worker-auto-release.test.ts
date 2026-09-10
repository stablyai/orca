import { describe, expect, it, vi } from 'vitest'
import { createPtyStopReceipt } from '../../../../shared/pty-stop-receipt'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { autoReleaseSettledWorkerTerminal } from '../../orchestration/worker-terminal-release-reconciliation'
import { completeWorkerTerminalRelease } from './orchestration/worker/worker-release-completion'

const resource = {
  id: 'resource-1',
  owner_dispatch_id: 'ctx-worker',
  terminal_handle: 'term-worker',
  worktree_id: 'repo::worktree',
  pane_key: 'tab-worker:leaf-worker',
  process_incarnation: 'pty-worker:incarnation-1',
  host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
  archive_source: 'terminal',
  archive_status: 'captured',
  ownership_state: 'owned',
  release_state: 'requested',
  prior_owner_dispatch_ids: '[]'
} as WorkerTerminalResourceRow

function exactRuntime(): OrcaRuntimeService {
  return {
    showTerminal: vi.fn(async () => ({
      handle: 'term-worker',
      connected: true,
      worktreeId: 'repo::worktree',
      ptyId: 'pty-worker',
      incarnationId: 'incarnation-1',
      executionHostId: 'local'
    })),
    getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
    getExactWorkerProviderSession: vi.fn(() => null),
    inspectTerminalProcessIncarnationLiveness: vi.fn(async () => 'live'),
    persistExitedWorkerTerminalRetirement: vi.fn(async () => true),
    notifyExitedWorkerTerminalRetirement: vi.fn(),
    getOrchestrationDispatchAuthority: vi.fn(() => ({
      terminalHandle: 'term-worker',
      worktreeId: 'repo::worktree',
      paneKey: 'tab-worker:leaf-worker',
      processIncarnation: 'pty-worker:incarnation-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })),
    closeTerminal: vi.fn(async () => {
      throw new Error('session_tab_not_found')
    }),
    listTerminals: vi.fn(async () => ({
      terminals: [],
      totalCount: 0,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    })),
    notifyMessageArrived: vi.fn()
  } as unknown as OrcaRuntimeService
}

function releaseDatabase(): OrchestrationDb {
  return {
    getWorkerDispatch: vi.fn(() => ({
      agent_terminal_handle: 'term-worker',
      created_at: '2026-08-21T00:00:00.000Z'
    })),
    isDispatchProcessCurrent: vi.fn(() => true),
    workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
    getWorkerTerminalArchive: vi.fn(() => ({
      dispatch_id: 'ctx-worker',
      resource_id: 'resource-1',
      kind: 'transcript_pin'
    })),
    commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
      ...resource,
      release_state: 'releasing'
    })),
    settleWorkerTerminalRelease: vi.fn(() => ({
      ...resource,
      release_state: 'released',
      ownership_state: 'released'
    })),
    markWorkerTerminalReleaseUnknown: vi.fn(() => ({
      ...resource,
      release_state: 'unknown',
      release_error: 'inventory unavailable'
    })),
    revertWorkerTerminalReleaseToRetained: vi.fn(() => ({
      ...resource,
      release_state: 'retained'
    }))
  } as unknown as OrchestrationDb
}

describe('orchestration worker auto-release', () => {
  it('settles a tab-close race only after fresh inventory proves the exact handle absent', async () => {
    const runtime = exactRuntime()
    const db = releaseDatabase()

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({
      state: 'already_absent',
      closeResponse: { error: 'tab_not_found' },
      inventoryResponse: { state: 'absent' }
    })
    expect(db.settleWorkerTerminalRelease).toHaveBeenCalledWith({
      resourceId: resource.id,
      ownerDispatchId: resource.owner_dispatch_id,
      processIncarnation: resource.process_incarnation
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps a tab-close race blocked when fresh inventory still has the exact incarnation', async () => {
    const runtime = exactRuntime()
    vi.mocked(runtime.listTerminals).mockResolvedValue({
      terminals: [
        {
          handle: 'term-worker',
          ptyId: 'pty-worker',
          incarnationId: 'incarnation-1',
          worktreeId: 'repo::worktree',
          executionHostId: 'local'
        }
      ],
      totalCount: 1,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    } as never)
    const db = releaseDatabase()

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({
      state: 'release_pending',
      inventoryResponse: { state: 'still_present' }
    })
    expect(db.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it('releases a settled worker after reproving its exact lease', async () => {
    const runtime = exactRuntime()
    vi.mocked(runtime.closeTerminal).mockResolvedValue({
      handle: 'term-worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('exited')
    const db = {
      ...releaseDatabase(),
      getFederatedDispatch: vi.fn(() => undefined),
      getWorkerDispatch: vi.fn(() => ({
        state: 'succeeded',
        agent_terminal_handle: 'term-worker',
        created_at: '2026-08-21T00:00:00.000Z'
      })),
      getWorkerTerminalResourceByOwner: vi.fn(() => ({
        ...resource,
        release_state: 'not_requested'
      })),
      listWorkerTerminalResources: vi.fn(() => []),
      requestWorkerTerminalRelease: vi.fn(() => ({
        disposition: 'requested' as const,
        resource: { ...resource, release_state: 'requested' }
      }))
    } as unknown as OrchestrationDb

    await expect(
      autoReleaseSettledWorkerTerminal({ runtime, db, dispatchId: 'ctx-worker' })
    ).resolves.toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term-worker')
    expect(db.requestWorkerTerminalRelease).toHaveBeenCalledWith('ctx-worker', { auto: true })
  })

  it('does not settle from a kill boolean while the exact process remains live', async () => {
    const runtime = exactRuntime()
    const db = releaseDatabase()
    vi.mocked(runtime.closeTerminal).mockResolvedValue({
      handle: 'term-worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('live')

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({ state: 'release_unknown', processVerdict: 'live' })
    expect(db.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it('settles only when the close carries a matching verified exit receipt', async () => {
    const runtime = exactRuntime()
    const db = releaseDatabase()
    const identity = {
      pid: 41,
      parentPid: 1,
      processGroupId: 41,
      startedAt: 'Mon Aug 24 08:00:00 2026'
    }
    const receipt = createPtyStopReceipt({
      executionHostId: 'local',
      terminalHandle: 'term-worker',
      ptyId: 'pty-worker',
      ptyIncarnation: resource.process_incarnation!,
      root: identity,
      descendants: [],
      observations: [{ identity, status: 'absent', observedAt: new Date().toISOString() }],
      verdict: 'exited',
      processTreeVerified: true
    })
    vi.mocked(runtime.closeTerminal).mockResolvedValue({
      handle: 'term-worker',
      tabId: 'tab-worker',
      ptyKilled: true,
      ptyStopReceipt: receipt,
      ptyStopVerdict: 'unverifiable'
    } as never)
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('live')

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({ state: 'released', processVerdict: 'exited' })
    expect(db.settleWorkerTerminalRelease).toHaveBeenCalledWith({
      resourceId: resource.id,
      ownerDispatchId: resource.owner_dispatch_id,
      processIncarnation: resource.process_incarnation
    })
  })

  it.each([
    {
      name: 'the inventory covers a different host',
      inventory: {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['ssh:other'], omittedHostIds: [] }
      },
      state: 'release_unknown'
    },
    {
      name: 'the inventory reports the handle in a different workspace',
      inventory: {
        terminals: [
          {
            handle: 'term-worker',
            ptyId: 'pty-worker',
            incarnationId: 'incarnation-1',
            worktreeId: 'repo::other',
            executionHostId: 'local'
          }
        ],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      },
      state: 'retained'
    }
  ])('does not settle a tab-close race when $name', async ({ inventory, state }) => {
    const runtime = exactRuntime()
    vi.mocked(runtime.listTerminals).mockResolvedValue(inventory as never)
    const db = releaseDatabase()

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({ state })
    expect(db.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'the dispatch process is stale',
      mutate: (_runtime: OrcaRuntimeService, db: OrchestrationDb) =>
        vi.mocked(db.isDispatchProcessCurrent).mockReturnValue(false)
    },
    {
      name: 'the host scope changed',
      mutate: (runtime: OrcaRuntimeService) =>
        vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
          hostScope: { kind: 'ssh', targetId: 'changed-host' }
        } as never)
    },
    {
      name: 'another resource conflicts with the exact identity',
      mutate: (_runtime: OrcaRuntimeService, db: OrchestrationDb) =>
        vi.mocked(db.workerTerminalResourceHasIdentityConflict).mockReturnValue(true)
    }
  ])('blocks auto-release when $name', async ({ mutate }) => {
    const runtime = exactRuntime()
    vi.mocked(runtime.closeTerminal).mockResolvedValue({
      handle: 'term-worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
    const db = autoReleaseDatabase()
    mutate(runtime, db)

    await expect(
      autoReleaseSettledWorkerTerminal({ runtime, db, dispatchId: 'ctx-worker' })
    ).resolves.toBeNull()
    expect(db.requestWorkerTerminalRelease).not.toHaveBeenCalled()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('blocks auto-release while another resource still owns the worktree', async () => {
    const runtime = exactRuntime()
    const db = autoReleaseDatabase([
      {
        resource: { ...resource, id: 'resource-2', release_state: 'retained' },
        terminalState: 'retained'
      }
    ])

    await expect(
      autoReleaseSettledWorkerTerminal({ runtime, db, dispatchId: 'ctx-worker' })
    ).resolves.toBeNull()
    expect(db.requestWorkerTerminalRelease).not.toHaveBeenCalled()
  })
})

function autoReleaseDatabase(
  otherResources: { resource: WorkerTerminalResourceRow; terminalState: string }[] = []
): OrchestrationDb {
  return {
    ...releaseDatabase(),
    getFederatedDispatch: vi.fn(() => undefined),
    getWorkerDispatch: vi.fn(() => ({
      state: 'succeeded',
      agent_terminal_handle: 'term-worker',
      created_at: '2026-08-21T00:00:00.000Z'
    })),
    getWorkerTerminalResourceByOwner: vi.fn(() => ({
      ...resource,
      release_state: 'not_requested'
    })),
    listWorkerTerminalResources: vi.fn(() => otherResources),
    requestWorkerTerminalRelease: vi.fn(() => ({
      disposition: 'requested' as const,
      resource: { ...resource, release_state: 'requested' }
    }))
  } as unknown as OrchestrationDb
}
