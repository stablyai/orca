import { describe, expect, it } from 'vitest'
import type { AgentGraphView } from '../../../../shared/maestro-contract'
import type {
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { applyMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import { projectMaestroWorkspaceLinks } from './maestro-workspace-link-projection'

const scope = { execution_host_id: 'local', workspace_key: 'folder:topology-workspace' }
const runId = 'run-topology'

type TerminalFixture = {
  tabId: string
  leafId: string
  handle: string
  taskId: string
  attemptId: string
  receiptId: string
  title: string
  role?: 'coordinator' | 'worker'
}

const parent: TerminalFixture = {
  tabId: 'terminal-parent',
  leafId: '11111111-1111-4111-8111-111111111111',
  handle: 'handle-parent',
  taskId: 'task-parent',
  attemptId: 'attempt-parent',
  receiptId: 'receipt-parent',
  title: 'Parent function'
}
const implementation: TerminalFixture = {
  tabId: 'terminal-implementation',
  leafId: '22222222-2222-4222-8222-222222222222',
  handle: 'handle-implementation',
  taskId: 'task-implementation',
  attemptId: 'attempt-implementation',
  receiptId: 'receipt-implementation',
  title: 'Implementation function'
}
const verification: TerminalFixture = {
  tabId: 'terminal-verification',
  leafId: '33333333-3333-4333-8333-333333333333',
  handle: 'handle-verification',
  taskId: 'task-verification',
  attemptId: 'attempt-verification',
  receiptId: 'receipt-verification',
  title: 'Verification function'
}
const context: TerminalFixture = {
  tabId: 'terminal-context',
  leafId: '44444444-4444-4444-8444-444444444444',
  handle: 'handle-context',
  taskId: 'task-context',
  attemptId: 'attempt-context',
  receiptId: 'receipt-context',
  title: 'Context function'
}

function terminalTab(fixture: TerminalFixture): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: `${fixture.tabId}::${fixture.leafId}`,
    parentTabId: fixture.tabId,
    leafId: fixture.leafId,
    ptyId: `pty-${fixture.tabId}`,
    status: 'ready',
    terminal: fixture.handle,
    title: fixture.title,
    isActive: false
  }
}

function terminalSurface(fixture: TerminalFixture): WorkspaceSurface {
  return {
    id: { ...scope, unified_tab_id: fixture.tabId },
    content_type: 'terminal',
    entity_id: fixture.tabId,
    group_id: 'group-1',
    title: fixture.title,
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: fixture.tabId,
      pane_key: fixture.leafId,
      session_id: `pty-${fixture.tabId}`,
      pty_incarnation: `incarnation-${fixture.tabId}`,
      liveness: 'live',
      authority_revision: 1
    }
  }
}

function session(fixtures: readonly TerminalFixture[]): RuntimeMobileSessionTabsResult {
  const tabs = fixtures.map(terminalTab)
  return {
    worktree: 'topology-workspace',
    publicationEpoch: 'renderer-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: fixtures[0]?.tabId ?? null,
    activeTabType: fixtures.length > 0 ? 'terminal' : null,
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: fixtures[0]?.tabId ?? null,
        tabOrder: fixtures.map((fixture) => fixture.tabId)
      }
    ],
    tabs
  }
}

function surfaces(fixtures: readonly TerminalFixture[]): Record<string, WorkspaceSurface> {
  return Object.fromEntries(
    fixtures.map((fixture) => [`surface-${fixture.tabId}`, terminalSurface(fixture)])
  )
}

function attachLease(database: OrchestrationDb, fixture: TerminalFixture): void {
  const lease = database.reserveMaestroTerminalLease({
    requestId: `request-${fixture.attemptId}`,
    executionHostId: scope.execution_host_id,
    workspaceKey: scope.workspace_key,
    runId,
    taskId: fixture.taskId,
    attemptId: fixture.attemptId,
    role: fixture.role ?? 'worker',
    workerTerminalResourceId: fixture.receiptId,
    title: fixture.title,
    launchProfile: {
      agent: 'codex',
      model: null,
      effort: 'high',
      permissionMode: 'default',
      routeRef: null
    },
    spawnedBy: 'coordinator:g1',
    ownerPrincipal: `worker:${fixture.attemptId}`,
    retentionPolicy: 'retain'
  })
  database.attachMaestroTerminalLease({
    leaseId: lease.id,
    terminalHandle: fixture.handle,
    tabId: fixture.tabId,
    paneKey: `${fixture.tabId}:${fixture.leafId}`,
    ptyIncarnation: `incarnation-${fixture.tabId}`,
    processRootId: `process-${fixture.tabId}`
  })
}

function graphView(): AgentGraphView {
  const fixtures = [parent, implementation, verification, context]
  return {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: 'repo-topology',
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
      run_id: runId,
      coordinator_generation: 1,
      binding_receipt_ref: 'artifact:workspace-bootstrap.json',
      binding_receipt_hash: `sha256:${'a'.repeat(64)}`
    },
    change: 'maestro-canvas-agent-topology-performance',
    run_id: runId,
    coordinator: { id: 'coordinator-generation-1', generation: 1 },
    capabilities: {
      agents: ['codex'],
      efforts: ['high'],
      placement_kinds: ['current-workspace'],
      watch_deltas: false
    },
    nodes: fixtures.flatMap((fixture) => [
      {
        id: fixture.taskId,
        type: 'task' as const,
        status: 'active',
        summary: fixture.title,
        task_id: fixture.taskId
      },
      {
        id: fixture.attemptId,
        type: 'attempt' as const,
        status: 'active',
        summary: fixture.title,
        task_id: fixture.taskId,
        attempt_id: fixture.attemptId
      },
      {
        id: fixture.receiptId,
        type: 'terminal-receipt' as const,
        status: 'active',
        summary: `${fixture.title} receipt`,
        task_id: fixture.taskId,
        attempt_id: fixture.attemptId,
        resource: {
          terminal_id: fixture.handle,
          terminal_status: 'running',
          liveness: 'live'
        }
      }
    ]),
    edges: [
      {
        id: 'edge-spawned',
        type: 'spawned_by',
        source_id: implementation.attemptId,
        target_id: parent.attemptId
      },
      {
        id: 'edge-dependency',
        type: 'depends_on',
        source_id: implementation.taskId,
        target_id: verification.taskId
      },
      {
        id: 'edge-report',
        type: 'reports_to',
        source_id: verification.taskId,
        target_id: parent.taskId
      },
      {
        id: 'edge-context',
        type: 'context_for',
        source_id: implementation.taskId,
        target_id: context.taskId
      }
    ],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 9,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined
  }
}

function publishGraph(database: OrchestrationDb): void {
  applyMaestroProjection.call(
    database,
    {
      repository_id: 'repo-topology',
      execution_host_id: scope.execution_host_id,
      workspace_key: scope.workspace_key,
      run_id: runId
    },
    graphView()
  )
}

function attachFixtures(database: OrchestrationDb, fixtures: readonly TerminalFixture[]): void {
  for (const fixture of fixtures) {
    attachLease(database, fixture)
  }
}

describe('Maestro workspace link projection', () => {
  it('projects exact parent links without widening the snapshot wire schema', () => {
    const database = new OrchestrationDb(':memory:')
    const fixtures = [parent, implementation, verification, context]
    attachFixtures(database, fixtures)
    publishGraph(database)
    const projectedSurfaces = surfaces(fixtures)
    const projectedSession = session(fixtures)

    const links = projectMaestroWorkspaceLinks({
      database,
      scope,
      session: projectedSession,
      surfaces: projectedSurfaces
    })
    expect(links.automatic_links).toEqual([
      expect.objectContaining({
        link_type: 'parent-child',
        authority_id: `${runId}:edge-spawned`
      })
    ])
    expect(links.suggested_links).toEqual([])
    database.close()
  })

  it('does not create peer suggestions from tab order without formal authority', () => {
    const database = new OrchestrationDb(':memory:')
    const fixtures = [parent, implementation, verification]
    const links: Pick<WorkspaceSurfaceSnapshot, 'automatic_links' | 'suggested_links'> =
      projectMaestroWorkspaceLinks({
        database,
        scope,
        session: session(fixtures),
        surfaces: surfaces(fixtures)
      })

    expect(links).toEqual({ automatic_links: [], suggested_links: [] })
    database.close()
  })
})
