import type { ScryKind, ScryModel } from '../model'
import type {
  ScryerNodeUpdateInput,
  ScryerNodeUpdateResult,
  ScryerOperationExecutor
} from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './operation-result'

function isScryKind(value: string): value is ScryKind {
  return (
    value === 'person' ||
    value === 'system' ||
    value === 'container' ||
    value === 'component' ||
    value === 'symbol'
  )
}

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

export const nodeUpdateOperation: ScryerOperationExecutor<
  ScryerNodeUpdateInput,
  ScryerNodeUpdateResult
> = ({ input, state, services }) => {
  if (!state.planned) {
    return failure('internal_error', 'Planned state was not loaded for node.update', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.node.update'
    })
  }
  const committed = state.committed ?? state.planned
  const planned = cloneModel(state.planned)
  let updatedCount = 0
  for (const patch of input.nodes) {
    const index = planned.nodes.findIndex((node) => node.id === patch.node_id)
    if (index === -1) {
      return failure('not_found', `Node '${patch.node_id}' not found`, {
        entity: 'node',
        id: patch.node_id,
        field: 'node_id'
      })
    }
    const node = planned.nodes[index]!
    if (patch.kind !== undefined) {
      if (!isScryKind(patch.kind)) {
        return failure('invalid_input', `invalid node kind '${patch.kind}'`, undefined, {
          fieldErrors: [{ path: 'nodes.kind', message: 'invalid Scryer node kind' }]
        })
      }
      node.kind = patch.kind
    }
    if (patch.name !== undefined) {
      node.name = patch.name
    }
    if (patch.description !== undefined) {
      node.description = patch.description
    }
    if (patch.technology !== undefined) {
      node.technology = patch.technology
    }
    if (patch.external !== undefined) {
      node.external = patch.external
    }
    if (patch.responsibilities !== undefined) {
      node.responsibilities = patch.responsibilities
    }
    if (patch.properties !== undefined) {
      node.properties = patch.properties
    }
    if (patch.visual !== undefined) {
      node.visual = patch.visual || undefined
    }
    if (patch.notes !== undefined) {
      node.notes = patch.notes || undefined
    }
    if (patch.appearance !== undefined) {
      const nextAppearance = { ...node.appearance }
      for (const [key, value] of Object.entries(patch.appearance)) {
        if (value === null) {
          delete nextAppearance[key]
        } else {
          nextAppearance[key] = value
        }
      }
      node.appearance = Object.keys(nextAppearance).length > 0 ? nextAppearance : undefined
    }
    if (patch.parent_id !== undefined) {
      node.parentId = patch.parent_id ?? undefined
    }
    updatedCount += 1
  }
  const findings = services.validators.validateModel(planned)
  return success({
    result: {
      updatedCount,
      findings,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
