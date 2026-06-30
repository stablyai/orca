import type { ScryModel } from '../model'
import type {
  ScryerLinkUpdateInput,
  ScryerLinkUpdateResult,
  ScryerOperationExecutor
} from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './helpers'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

export const linkUpdateOperation: ScryerOperationExecutor<
  ScryerLinkUpdateInput,
  ScryerLinkUpdateResult
> = ({ input, state, services }) => {
  if (!state.planned) {
    return failure('internal_error', 'Planned state was not loaded for link.update', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.link.update'
    })
  }
  const committed = state.committed ?? state.planned
  const planned = cloneModel(state.planned)
  let updatedCount = 0

  for (const patch of input.links) {
    const link = planned.links.find((candidate) => candidate.id === patch.link_id)
    if (!link) {
      return failure('not_found', `Link '${patch.link_id}' not found`, {
        entity: 'link',
        id: patch.link_id,
        field: 'link_id'
      })
    }
    if (patch.label !== undefined) {
      link.label = patch.label
    }
    if (patch.method !== undefined) {
      link.method = patch.method
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
