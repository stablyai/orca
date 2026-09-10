import { canConsumeMaestroIntent, canRequestMaestroIntent } from '../../../../shared/maestro-actor'
import type { MaestroDelegationRequest } from '../../../../shared/maestro-delegation'
import { documentRow } from '../../orchestration/db/maestro/maestro-document-store-core'
import { getMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RpcContext } from '../core'
import type { resolveMaestroPrincipal } from '../maestro-principal'
function hasActiveDelegationStatus(status: string): boolean {
  return status === 'active' || status === 'running'
}

export function requireRequestPrincipal(
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>,
  workspace: MaestroDelegationRequest['workspace']
): void {
  if (!canRequestMaestroIntent(principal, workspace)) {
    throw new OrchestrationError(
      'unauthorized',
      'The authenticated session cannot request this delegation.'
    )
  }
}

export function requireCoordinatorPrincipal(
  principal: Awaited<ReturnType<typeof resolveMaestroPrincipal>>,
  workspace: MaestroDelegationRequest['workspace'],
  generation: number,
  action: string
): void {
  if (!canConsumeMaestroIntent(principal, workspace, generation)) {
    throw new OrchestrationError(
      'unauthorized',
      `Only the authenticated current coordinator can ${action}.`
    )
  }
}

export function requireSourceBoundParents(
  request: MaestroDelegationRequest,
  database: ReturnType<RpcContext['runtime']['getOrchestrationDb']>
): void {
  const projection = getMaestroProjection.call(database, {
    execution_host_id: request.workspace.execution_host_id,
    workspace_key: request.workspace.workspace_key
  })
  const run = database.getRun(request.workspace.run_id)
  if (
    !projection ||
    !run ||
    projection.runId !== request.workspace.run_id ||
    projection.repositoryId !== request.workspace.repository_id ||
    projection.coordinator.generation !== run.consumer_generation ||
    projection.workspace.executionHostId !== request.workspace.execution_host_id ||
    projection.workspace.workspaceKey !== request.workspace.workspace_key
  ) {
    throw new OrchestrationError(
      'unauthorized',
      'The delegation source is not present in the authoritative Maestro projection.'
    )
  }
  const inWorkspace = (node: (typeof projection.nodes)[number]): boolean =>
    node.executionHostId === request.workspace.execution_host_id &&
    node.workspaceKey === request.workspace.workspace_key
  const activeTask = projection.nodes.find(
    (node) =>
      node.type === 'task' &&
      node.taskId === request.parent_task_id &&
      hasActiveDelegationStatus(node.rawStatus) &&
      inWorkspace(node)
  )
  if (!request.parent_task_id || !activeTask) {
    throw new OrchestrationError(
      'unauthorized',
      'The delegation task parent is not bound to this Orca Run.'
    )
  }
  const parentAttempt = request.parent_attempt_id
    ? projection.nodes.find(
        (node) =>
          node.type === 'attempt' &&
          node.attemptId === request.parent_attempt_id &&
          node.taskId === request.parent_task_id &&
          hasActiveDelegationStatus(node.rawStatus) &&
          inWorkspace(node)
      )
    : undefined
  if (request.parent_attempt_id && !parentAttempt) {
    throw new OrchestrationError(
      'unauthorized',
      'The delegation attempt parent is not active in this Orca Run.'
    )
  }
  if (request.source.kind === 'task') {
    if (request.source.task_id !== request.parent_task_id || request.parent_attempt_id !== null) {
      throw new OrchestrationError(
        'unauthorized',
        'The delegation task source must be its exact active parent.'
      )
    }
    return
  }
  if (request.source.kind === 'attempt') {
    if (request.source.attempt_id !== request.parent_attempt_id || !parentAttempt) {
      throw new OrchestrationError(
        'unauthorized',
        'The delegation attempt source must be its exact active parent.'
      )
    }
    return
  }
  if (request.source.kind === 'note') {
    const documentScope = {
      execution_host_id: request.workspace.execution_host_id,
      workspace_key: request.workspace.workspace_key
    }
    const row = documentRow.call(database, documentScope)
    const document = database.getMaestroDocument({
      ...documentScope
    })
    const note = document.document?.nodes[request.source.note_id]
    if (
      row?.run_id !== request.workspace.run_id ||
      !note ||
      note.kind !== 'note' ||
      String(note.note_revision) !== request.source.revision
    ) {
      throw new OrchestrationError(
        'unauthorized',
        'The delegation note source revision is stale or unavailable.'
      )
    }
  }
}
