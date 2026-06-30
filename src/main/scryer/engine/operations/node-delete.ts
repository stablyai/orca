import type { ScryModel } from '../model'
import type {
  ScryerNodeDeleteInput,
  ScryerNodeDeleteResult,
  ScryerOperationExecutor
} from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './helpers'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

function collectDescendantIds(model: ScryModel, nodeIds: string[]): Set<string> {
  const ids = new Set(nodeIds)
  let changed = true
  while (changed) {
    changed = false
    for (const node of model.nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        changed = true
      }
    }
  }
  return ids
}

export const nodeDeleteOperation: ScryerOperationExecutor<
  ScryerNodeDeleteInput,
  ScryerNodeDeleteResult
> = ({ input, state, services }) => {
  if (!state.planned) {
    return failure('internal_error', 'Planned state was not loaded for node.delete', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.node.delete'
    })
  }

  const committed = state.committed ?? state.planned
  const planned = cloneModel(state.planned)
  const existing = new Set(planned.nodes.map((node) => node.id))
  const missingIds = input.node_ids.filter((id) => !existing.has(id))
  if (missingIds.length > 0) {
    return failure('not_found', `Node '${missingIds[0]}' not found`, {
      entity: 'node',
      id: missingIds[0],
      field: 'node_ids'
    })
  }

  const toDelete = collectDescendantIds(planned, input.node_ids)
  const beforeNodes = planned.nodes.length
  const beforeLinks = planned.links.length

  planned.nodes = planned.nodes.filter((node) => !toDelete.has(node.id))
  planned.links = planned.links.filter((link) => !toDelete.has(link.src) && !toDelete.has(link.dst))
  for (const id of toDelete) {
    delete planned.sourceMap[id]
    delete planned.boundaries[id]
  }

  planned.groups = planned.groups
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((memberId) => !toDelete.has(memberId)),
      ...(group.parentNodeId && toDelete.has(group.parentNodeId) ? { parentNodeId: undefined } : {})
    }))
    .filter((group) => group.memberIds.length > 0)

  const remainingGroupIds = new Set(planned.groups.map((group) => group.id))
  planned.groups = planned.groups.map((group) =>
    group.parentGroupId && !remainingGroupIds.has(group.parentGroupId)
      ? { ...group, parentGroupId: undefined }
      : group
  )

  const findings = services.validators.validateModel(planned)
  return success({
    result: {
      deletedCount: beforeNodes - planned.nodes.length,
      deletedLinkCount: beforeLinks - planned.links.length,
      findings,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
