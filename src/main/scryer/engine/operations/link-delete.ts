import type { ScryModel } from '../model'
import type {
  ScryerLinkDeleteInput,
  ScryerLinkDeleteResult,
  ScryerOperationExecutor
} from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './operation-result'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

export const linkDeleteOperation: ScryerOperationExecutor<
  ScryerLinkDeleteInput,
  ScryerLinkDeleteResult
> = ({ input, state }) => {
  if (!state.planned) {
    return failure('internal_error', 'Planned state was not loaded for link.delete', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.link.delete'
    })
  }
  const committed = state.committed ?? state.planned
  const planned = cloneModel(state.planned)
  const targets = new Set(input.link_ids)
  const existing = new Set(planned.links.map((link) => link.id))
  const missingIds = input.link_ids.filter((id) => !existing.has(id))
  const before = planned.links.length
  planned.links = planned.links.filter((link) => !targets.has(link.id))
  return success({
    result: {
      deletedCount: before - planned.links.length,
      ...(missingIds.length > 0 ? { missingIds } : {}),
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
