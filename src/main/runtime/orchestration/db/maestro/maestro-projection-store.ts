import type {
  AgentGraphView,
  MaestroDocumentReadScope,
  MaestroWorkspaceAnchor
} from '../../../../../shared/maestro-contract'
import { parseAgentGraphView } from '../../../../../shared/maestro-contract'
import {
  MaestroBootstrapReceiptSchema,
  type MaestroBootstrapReceipt,
  type MaestroBootstrapRequest
} from '../../../../../shared/maestro-bootstrap-contract'
import {
  applyAgentGraphDelta,
  projectAgentGraphView,
  type MaestroProjection
} from '../../../../../shared/maestro-projection'
import type { OrchestrationDb } from '../orchestration-db'
import {
  listStoredMaestroProjections,
  persistMaestroBootstrapRecord,
  persistMaestroProjectionScopes,
  readMaestroBootstrapByMutation,
  readMaestroBootstrapByWorkspace,
  readStoredMaestroProjection,
  type StoredMaestroProjection
} from './maestro-projection-persistence'

function requireMatchingAuthority(workspace: MaestroWorkspaceAnchor, view: AgentGraphView): void {
  const home = view.workspace_scope.orchestration_home
  if (
    workspace.repository_id !== view.workspace_scope.repository_id ||
    workspace.run_id !== view.run_id ||
    view.workspace_scope.run_id !== view.run_id ||
    workspace.execution_host_id !== home.execution_host_id ||
    workspace.workspace_key !== home.workspace_key ||
    view.coordinator.generation !== view.workspace_scope.coordinator_generation
  ) {
    throw new Error('AgentGraphView is not bound to the publishing coordinator workspace.')
  }
  if (
    (view.cursor && view.cursor.revision !== view.revision) ||
    (view.kind === 'snapshot' && (view.from_cursor !== null || view.reset_required))
  ) {
    throw new Error('AgentGraphView snapshot or cursor is inconsistent.')
  }
}

export function applyMaestroProjection(
  this: OrchestrationDb,
  workspace: MaestroWorkspaceAnchor,
  view: AgentGraphView
): MaestroProjection {
  const sanitizedView = parseAgentGraphView(view)
  requireMatchingAuthority(workspace, sanitizedView)
  const home = sanitizedView.workspace_scope.orchestration_home
  const execution = sanitizedView.workspace_scope.execution_workspace
  const existing = readStoredMaestroProjection(this, home, sanitizedView.run_id)
  const nextView =
    sanitizedView.kind === 'snapshot'
      ? resolveSnapshot(existing, sanitizedView)
      : applyAgentGraphDelta(
          existing?.view ??
            (() => {
              throw new Error('AgentGraphView delta has no active snapshot.')
            })(),
          sanitizedView
        )
  persistMaestroProjectionScopes(this, nextView, [home, execution], new Date().toISOString())
  return projectAgentGraphView(nextView, {
    executionHostId: home.execution_host_id,
    workspaceKey: home.workspace_key
  })
}

export function getMaestroProjection(
  this: OrchestrationDb,
  scope: MaestroDocumentReadScope,
  runId?: string
): MaestroProjection | null {
  const projection = readStoredMaestroProjection(this, scope, runId)
  if (!projection) {
    return null
  }
  return projectAgentGraphView(projection.view, {
    executionHostId: scope.execution_host_id,
    workspaceKey: scope.workspace_key
  })
}

export function listMaestroRunProgress(this: OrchestrationDb): {
  runId: string
  executionHostId: string
  workspaceKey: string
  runProgress: MaestroProjection['runProgress']
}[] {
  return uniqueProjections(this).map(({ view }) => ({
    runId: view.run_id,
    executionHostId: view.workspace_scope.execution_workspace.execution_host_id,
    workspaceKey: view.workspace_scope.execution_workspace.workspace_key,
    runProgress: projectAgentGraphView(view, {
      executionHostId: view.workspace_scope.execution_workspace.execution_host_id,
      workspaceKey: view.workspace_scope.execution_workspace.workspace_key
    }).runProgress
  }))
}

export function listMaestroProjectionIndex(this: OrchestrationDb): {
  executionHostId: string
  workspaceKey: string
  revision: number
  updatedAt: string
  runId: string
}[] {
  return uniqueProjections(this).map(({ view, updatedAt }) => ({
    executionHostId: view.workspace_scope.execution_workspace.execution_host_id,
    workspaceKey: view.workspace_scope.execution_workspace.workspace_key,
    revision: view.revision,
    updatedAt,
    runId: view.run_id
  }))
}

export function listMaestroProjectionIndexForScope(
  this: OrchestrationDb,
  scope: MaestroDocumentReadScope
): ReturnType<typeof listMaestroProjectionIndex> {
  return uniqueProjections(this).flatMap(({ view, updatedAt }) => {
    const home = view.workspace_scope.orchestration_home
    const execution = view.workspace_scope.execution_workspace
    const matches = [home, execution].some(
      (candidate) =>
        candidate.execution_host_id === scope.execution_host_id &&
        candidate.workspace_key === scope.workspace_key
    )
    return matches
      ? [
          {
            executionHostId: scope.execution_host_id,
            workspaceKey: scope.workspace_key,
            revision: view.revision,
            updatedAt,
            runId: view.run_id
          }
        ]
      : []
  })
}

export function applyMaestroBootstrapProjection(
  this: OrchestrationDb,
  workspace: MaestroWorkspaceAnchor,
  view: AgentGraphView
): 'published' | 'replayed' {
  const sanitizedView = parseAgentGraphView(view)
  if (sanitizedView.kind !== 'snapshot' || sanitizedView.revision !== 0) {
    throw new Error('Maestro bootstrap requires a revision-zero snapshot.')
  }
  requireMatchingAuthority(workspace, sanitizedView)
  const scopes = [
    sanitizedView.workspace_scope.orchestration_home,
    sanitizedView.workspace_scope.execution_workspace
  ]
  const existing = scopes
    .map((scope) => readStoredMaestroProjection(this, scope, sanitizedView.run_id))
    .find(Boolean)
  if (existing) {
    if (!sameBootstrapBinding(existing.view, sanitizedView)) {
      throw new Error('Maestro bootstrap conflicts with the active Run or workspace base.')
    }
    return 'replayed'
  }
  applyMaestroProjection.call(this, workspace, sanitizedView)
  return 'published'
}

export function replayMaestroBootstrap(
  this: OrchestrationDb,
  request: MaestroBootstrapRequest
): MaestroBootstrapReceipt | null {
  const existingMutation = readMaestroBootstrapByMutation(this, request.mutation.mutation_id)
  if (existingMutation) {
    if (JSON.stringify(existingMutation.request) !== JSON.stringify(request)) {
      throw new Error('Maestro bootstrap mutation identity was reused with different input.')
    }
    return { ...existingMutation.receipt, outcome: 'replayed' }
  }
  const existingWorkspace = readMaestroBootstrapByWorkspace(this, request.mutation)
  if (!existingWorkspace) {
    return null
  }
  if (
    existingWorkspace.receipt.mutation.run_id !== request.mutation.run_id ||
    existingWorkspace.receipt.coordinator_generation !== request.coordinator_generation
  ) {
    throw new Error('Maestro bootstrap conflicts with the active Run binding.')
  }
  const replay = MaestroBootstrapReceiptSchema.parse({
    ...existingWorkspace.receipt,
    mutation: request.mutation,
    outcome: 'replayed'
  })
  persistMaestroBootstrapRecord(this, request, replay)
  return replay
}

export function recordMaestroBootstrap(
  this: OrchestrationDb,
  request: MaestroBootstrapRequest,
  receipt: MaestroBootstrapReceipt
): void {
  const parsed = MaestroBootstrapReceiptSchema.parse(receipt)
  persistMaestroBootstrapRecord(this, request, parsed)
}

function uniqueProjections(database: OrchestrationDb): StoredMaestroProjection[] {
  return listStoredMaestroProjections(database)
}

function resolveSnapshot(
  existing: StoredMaestroProjection | null,
  incoming: AgentGraphView
): AgentGraphView {
  if (!existing) {
    return incoming
  }
  if (incoming.revision < existing.view.revision) {
    throw new Error('AgentGraphView snapshot revision is stale for this Run.')
  }
  if (incoming.revision === existing.view.revision) {
    if (
      JSON.stringify(incoming) !== JSON.stringify(existing.view) &&
      !sameProjectionContentAcrossCoordinatorTakeover(existing.view, incoming)
    ) {
      throw new Error('AgentGraphView revision was reused with different projection content.')
    }
    return incoming
  }
  return incoming
}

function sameProjectionContentAcrossCoordinatorTakeover(
  existing: AgentGraphView,
  incoming: AgentGraphView
): boolean {
  if (
    existing.run_id !== incoming.run_id ||
    existing.coordinator.generation === incoming.coordinator.generation
  ) {
    return false
  }
  const normalizedIncoming = {
    ...incoming,
    coordinator: existing.coordinator,
    workspace_scope: {
      ...incoming.workspace_scope,
      coordinator_generation: existing.workspace_scope.coordinator_generation
    }
  }
  return JSON.stringify(normalizedIncoming) === JSON.stringify(existing)
}

function sameBootstrapBinding(left: AgentGraphView, right: AgentGraphView): boolean {
  return (
    left.run_id === right.run_id &&
    left.workspace_scope.repository_id === right.workspace_scope.repository_id &&
    left.workspace_scope.base_revision === right.workspace_scope.base_revision &&
    left.coordinator.generation === right.coordinator.generation &&
    JSON.stringify(left.workspace_scope.orchestration_home) ===
      JSON.stringify(right.workspace_scope.orchestration_home) &&
    JSON.stringify(left.workspace_scope.execution_workspace) ===
      JSON.stringify(right.workspace_scope.execution_workspace)
  )
}
