import { vi, type MockedFunction } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { applyMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import {
  MaestroWorkspaceCanvasAuthority,
  type MaestroWorkspaceCanvasRuntime
} from '../../services/maestro-workspace-canvas/maestro-workspace-canvas-authority'
import {
  browserReceipt,
  editorSession,
  linkedSession,
  parentChildSession,
  scope,
  session
} from './maestro-workspace-canvas-session-fixtures'

export { editorSession, linkedSession, parentChildSession, scope, session }

type CanvasRuntimeTestDouble = MaestroWorkspaceCanvasRuntime & {
  listMobileSessionTabs: MockedFunction<MaestroWorkspaceCanvasRuntime['listMobileSessionTabs']>
  listTerminals: MockedFunction<MaestroWorkspaceCanvasRuntime['listTerminals']>
  browserTabCreate: MockedFunction<MaestroWorkspaceCanvasRuntime['browserTabCreate']>
  commandMaestroWorkspaceTab: MockedFunction<
    MaestroWorkspaceCanvasRuntime['commandMaestroWorkspaceTab']
  >
}

type MaestroWorkspaceCanvasHarness = {
  authority: MaestroWorkspaceCanvasAuthority
  database: OrchestrationDb
  runtime: CanvasRuntimeTestDouble
}

export function publishLinkGraph(
  database: OrchestrationDb,
  params?: {
    revision?: number
    browserIdentity?: Parameters<typeof browserReceipt>[0]
    duplicateBrowserReceipt?: boolean
    parentChild?: boolean
  }
): void {
  const revision = params?.revision ?? 7
  const browser = browserReceipt(params?.browserIdentity)
  applyMaestroProjection.call(
    database,
    {
      repository_id: 'repo-1',
      execution_host_id: scope.execution_host_id,
      workspace_key: scope.workspace_key,
      run_id: 'run-1'
    },
    {
      schema_version: 1,
      protocol: 'agent-graph-view/v1',
      kind: 'snapshot',
      workspace_scope: {
        schema_version: 1,
        repository_id: 'repo-1',
        canonical_root: '/workspace',
        execution_host: { id: scope.execution_host_id, boundary: 'local' },
        orchestration_home: {
          execution_host_id: scope.execution_host_id,
          workspace_key: scope.workspace_key,
          kind: 'folder',
          path: '/workspace'
        },
        execution_workspace: {
          execution_host_id: scope.execution_host_id,
          workspace_key: scope.workspace_key,
          kind: 'folder',
          path: '/workspace'
        },
        base_revision: 'base-1',
        dirty_paths: [],
        run_id: 'run-1',
        coordinator_generation: 2,
        binding_receipt_ref: 'artifact:workspace-bootstrap.json',
        binding_receipt_hash: `sha256:${'a'.repeat(64)}`
      },
      change: 'maestro-workspace-tab-canvas',
      run_id: 'run-1',
      coordinator: { id: 'coordinator-generation-2', generation: 2 },
      capabilities: {
        agents: ['codex'],
        efforts: ['high'],
        placement_kinds: ['current-workspace'],
        watch_deltas: false
      },
      nodes: [
        {
          id: 'terminal-receipt-1',
          type: 'terminal-receipt',
          status: 'active',
          summary: 'Exact Codex terminal receipt',
          ...(params?.parentChild ? { attempt_id: 'attempt-mwc-integ-002' } : {}),
          resource: {
            ...(params?.parentChild ? { attempt_id: 'attempt-mwc-integ-002' } : {}),
            terminal_id: 'terminal-handle-1',
            terminal_status: 'running',
            liveness: 'live'
          }
        },
        {
          id: 'browser-receipt-1',
          type: 'browser-surface',
          status: 'active',
          summary: 'Exact Browser surface receipt',
          resource: browser
        },
        ...(params?.duplicateBrowserReceipt
          ? [
              {
                id: 'browser-receipt-duplicate',
                type: 'browser-surface' as const,
                status: 'active',
                summary: 'Duplicate exact Browser receipt',
                resource: {
                  ...browser,
                  surface_id: 'browser-surface-duplicate',
                  request_id: 'browser-request-duplicate'
                }
              }
            ]
          : []),
        ...(params?.parentChild
          ? [
              {
                id: 'terminal-receipt-parent',
                type: 'terminal-receipt' as const,
                status: 'active',
                summary: 'Exact parent terminal receipt',
                attempt_id: 'attempt-mwc-parent-001',
                resource: {
                  attempt_id: 'attempt-mwc-parent-001',
                  terminal_id: 'terminal-handle-parent',
                  terminal_status: 'running',
                  liveness: 'live' as const
                }
              },
              {
                id: 'attempt-child',
                type: 'attempt' as const,
                status: 'active',
                summary: 'Child attempt',
                task_id: 'MWC-INTEG',
                attempt_id: 'attempt-mwc-integ-002'
              },
              {
                id: 'attempt-parent',
                type: 'attempt' as const,
                status: 'active',
                summary: 'Parent attempt',
                task_id: 'MWC-INTEG',
                attempt_id: 'attempt-mwc-parent-001'
              }
            ]
          : [])
      ],
      edges: [
        {
          id: 'edge-terminal-executes-browser',
          type: 'executes',
          source_id: 'terminal-receipt-1',
          target_id: 'browser-receipt-1'
        },
        ...(params?.parentChild
          ? [
              {
                id: 'edge-child-spawned-by-parent',
                type: 'spawned_by' as const,
                source_id: 'attempt-child',
                target_id: 'attempt-parent'
              }
            ]
          : [])
      ],
      removed_node_ids: [],
      removed_edge_ids: [],
      revision,
      cursor: null,
      from_cursor: null,
      reset_required: false,
      progress: undefined
    }
  )
}

export function attachLinkLease(
  database: OrchestrationDb,
  overrides: {
    runId?: string
    taskId?: string
    attemptId?: string
    agent?: 'codex' | null
  } = {}
): void {
  const lease = database.reserveMaestroTerminalLease({
    requestId: `terminal-request-${overrides.runId ?? 'run-1'}-${overrides.taskId ?? 'MWC-INTEG'}-${overrides.attemptId ?? 'attempt-mwc-integ-002'}-${overrides.agent ?? 'none'}`,
    executionHostId: scope.execution_host_id,
    workspaceKey: scope.workspace_key,
    runId: overrides.runId ?? 'run-1',
    taskId: overrides.taskId ?? 'MWC-INTEG',
    attemptId: overrides.attemptId ?? 'attempt-mwc-integ-002',
    role: 'worker',
    workerTerminalResourceId: 'terminal-receipt-1',
    title: 'MWC-INTEG · worker · Codex',
    launchProfile: {
      agent: overrides.agent === undefined ? 'codex' : overrides.agent,
      model: null,
      effort: 'high',
      permissionMode: 'default',
      routeRef: null
    },
    spawnedBy: 'coordinator-generation-2',
    ownerPrincipal: 'worker:attempt-mwc-integ-002',
    retentionPolicy: 'retain'
  })
  database.attachMaestroTerminalLease({
    leaseId: lease.id,
    terminalHandle: 'terminal-handle-1',
    tabId: 'terminal-tab-1',
    paneKey: 'leaf-1',
    ptyIncarnation: 'pty-1:incarnation-7',
    processRootId: 'pid:1'
  })
}

export function attachParentLinkLease(database: OrchestrationDb): void {
  const lease = database.reserveMaestroTerminalLease({
    requestId: 'terminal-request-run-1-MWC-INTEG-attempt-mwc-parent-001-codex',
    executionHostId: scope.execution_host_id,
    workspaceKey: scope.workspace_key,
    runId: 'run-1',
    taskId: 'MWC-INTEG',
    attemptId: 'attempt-mwc-parent-001',
    role: 'worker',
    workerTerminalResourceId: 'terminal-receipt-parent',
    title: 'MWC-INTEG · parent · Codex',
    launchProfile: {
      agent: 'codex',
      model: null,
      effort: 'high',
      permissionMode: 'default',
      routeRef: null
    },
    spawnedBy: 'coordinator:g2',
    ownerPrincipal: 'worker:attempt-mwc-parent-001',
    retentionPolicy: 'retain'
  })
  database.attachMaestroTerminalLease({
    leaseId: lease.id,
    terminalHandle: 'terminal-handle-parent',
    tabId: 'terminal-tab-parent',
    paneKey: 'leaf-parent',
    ptyIncarnation: 'pty-parent:incarnation-1',
    processRootId: 'pid:parent'
  })
}

export function harness(): MaestroWorkspaceCanvasHarness {
  const database = new OrchestrationDb(':memory:')
  const listMobileSessionTabs = vi.fn().mockResolvedValue(session())
  const runtime = {
    listMobileSessionTabs,
    listTerminals: vi.fn().mockResolvedValue({ terminals: [], totalCount: 0, truncated: false }),
    activateMobileSessionTab: vi.fn().mockResolvedValue(session()),
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true }),
    createMobileSessionTerminal: vi.fn().mockResolvedValue({
      tab: session().tabs[0],
      publicationEpoch: 'renderer-1',
      snapshotVersion: 2
    }),
    browserTabCreate: vi.fn().mockResolvedValue({ browserPageId: 'browser-page-2' }),
    createMaestroWorkspaceAnnotation: vi.fn().mockResolvedValue({
      worktreeId: 'folder-1',
      filePath: '/workspace/.orca/maestro/annotation.md'
    }),
    commandMaestroWorkspaceTab: vi.fn().mockResolvedValue({ tabId: 'annotation-tab-1' }),
    readMobileMarkdownTab: vi.fn(),
    saveMobileMarkdownTab: vi.fn(),
    readMobileFile: vi
      .fn()
      .mockResolvedValue({ content: 'exact content', truncated: false, byteLength: 13 }),
    getTerminalProcessIncarnation: vi.fn().mockReturnValue('pty-1:incarnation-7'),
    getOrchestrationDb: () => database
  } satisfies MaestroWorkspaceCanvasRuntime
  return {
    authority: new MaestroWorkspaceCanvasAuthority(runtime),
    database,
    runtime: runtime as CanvasRuntimeTestDouble
  }
}
