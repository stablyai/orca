import { describe, expect, it, vi } from 'vitest'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import { SharedExecutionHostResourceCollector } from '../../maestro-resource-inventory'
import type { RpcContext } from '../core'
import { collectRuntimeResourceHealth } from './runtime-resource-health'

const MEMORY: MemorySnapshot = {
  app: {
    cpu: 1,
    memory: 100,
    main: { cpu: 1, memory: 100 },
    renderer: { cpu: 0, memory: 0 },
    other: { cpu: 0, memory: 0 },
    rendererProcessCount: 0,
    history: []
  },
  worktrees: [],
  host: {
    totalMemory: 1_000,
    freeMemory: 800,
    availableMemory: 800,
    availableMemorySource: 'free-memory',
    usedMemory: 200,
    memoryUsagePercent: 20,
    cpuCoreCount: 4,
    loadAverage1m: 0
  },
  processMemoryMetric: 'rss',
  totalCpu: 1,
  totalMemory: 100,
  collectedAt: 10
}

function context(database: object): RpcContext {
  const daemonContext = {
    protocolGeneration: 42,
    provider: 'local-daemon' as const,
    endpoint: '/tmp/orca.sock',
    tokenPath: '/tmp/orca.token',
    endpointKind: 'unix-socket' as const,
    profileScope: 'test'
  }
  const runtime = {
    listFolderWorkspaces: vi.fn(() => [
      {
        id: 'workspace-a',
        name: 'Workspace A',
        path: '/workspace/a',
        connectionId: null,
        executionHostId: 'local'
      },
      {
        id: 'workspace-b',
        name: 'Workspace B',
        path: '/workspace/b',
        connectionId: null,
        executionHostId: 'local'
      }
    ]),
    listManagedWorktrees: vi.fn(async () => ({ worktrees: [] })),
    listRepos: vi.fn(() => []),
    getMemorySnapshot: vi.fn(async () => MEMORY),
    getLocalProvider: vi.fn(() => ({
      listSessions: vi.fn(async () => []),
      getLastAuthenticatedDaemonIdentity: () => ({
        pid: process.pid,
        startedAtMs: 1,
        launchNonce: 'nonce'
      }),
      getLastAuditObservation: () => ({
        state: 'present' as const,
        reason: 'authenticated_inventory' as const,
        trigger: 'inventory_answered' as const,
        evidenceSources: ['authenticated_inventory'] as const,
        context: daemonContext,
        exactIncarnation: null,
        reachability: 'authenticated' as const,
        inventoryAuthority: 'authoritative' as const,
        processLiveness: 'unknown' as const,
        processReason: null,
        endpointState: 'socket' as const,
        observedAtMs: 1
      })
    })),
    getOrchestrationDb: vi.fn(() => database)
  }
  return { runtime } as unknown as RpcContext
}

const PARAMS = {
  executionHostId: 'local',
  workspaceKey: 'folder:workspace-a',
  visible: true
}

describe('runtime.resourceHealth', () => {
  it('rejects a forged host before collecting local resource data', async () => {
    const rpc = context({})

    const result = await collectRuntimeResourceHealth(
      { ...PARAMS, executionHostId: 'ssh:build-host' },
      rpc,
      new SharedExecutionHostResourceCollector()
    )

    expect(result.state).toBe('unverifiable')
    expect(rpc.runtime.getMemorySnapshot).not.toHaveBeenCalled()
    expect(rpc.runtime.getLocalProvider).not.toHaveBeenCalled()
  })

  it('distinguishes an authoritative empty inventory from an unavailable source', async () => {
    const empty = context({
      listWorkerTerminalResources: () => [],
      listReconcilableMaestroBrowserSurfaces: () => []
    })
    const unavailable = context({
      listWorkerTerminalResources: () => {
        throw new Error('database unavailable')
      },
      listReconcilableMaestroBrowserSurfaces: () => []
    })

    await expect(
      collectRuntimeResourceHealth(PARAMS, empty, new SharedExecutionHostResourceCollector())
    ).resolves.toMatchObject({
      state: 'normal',
      inventory: { workerIds: [], browserSurfaceIds: [] }
    })
    await expect(
      collectRuntimeResourceHealth(PARAMS, unavailable, new SharedExecutionHostResourceCollector())
    ).resolves.toMatchObject({ state: 'unverifiable' })
  })

  it('filters durable resources by the exact proven workspace', async () => {
    const localScope = JSON.stringify({ kind: 'local', hostId: 'local' })
    const rpc = context({
      listWorkerTerminalResources: () => [
        {
          dispatchId: 'worker-a',
          resource: { host_scope: localScope, worktree_id: 'folder:workspace-a' }
        },
        {
          dispatchId: 'worker-b',
          resource: { host_scope: localScope, worktree_id: 'folder:workspace-b' }
        }
      ],
      listReconcilableMaestroBrowserSurfaces: () => [
        {
          receipt: {
            surface_id: 'browser-a',
            execution_host_id: 'local',
            workspace_key: 'folder:workspace-a'
          }
        },
        {
          receipt: {
            surface_id: 'browser-b',
            execution_host_id: 'local',
            workspace_key: 'folder:workspace-b'
          }
        }
      ]
    })
    const collector = new SharedExecutionHostResourceCollector()

    const [first, second] = await Promise.all([
      collectRuntimeResourceHealth(PARAMS, rpc, collector),
      collectRuntimeResourceHealth(
        { ...PARAMS, workspaceKey: 'folder:workspace-b' },
        rpc,
        collector
      )
    ])

    expect(first.inventory.workerIds).toEqual(['worker-a'])
    expect(first.inventory.browserSurfaceIds).toEqual(['browser-a'])
    expect(second.inventory.workerIds).toEqual(['worker-b'])
    expect(second.inventory.browserSurfaceIds).toEqual(['browser-b'])
  })
})
