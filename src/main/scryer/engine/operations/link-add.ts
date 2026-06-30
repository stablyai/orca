import type { ScryModel } from '../model'
import type { ScryerLinkAddInput, ScryerLinkAddResult, ScryerOperationExecutor } from '../types'
import { diffModels, summarizePending } from '../diff'
import { linkViolation } from '../validators'
import { failure, success } from './helpers'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

export function makeLinkId(src: string, dst: string): string {
  return `link-${src}-${dst}`
}

export const linkAddOperation: ScryerOperationExecutor<ScryerLinkAddInput, ScryerLinkAddResult> = ({
  input,
  state,
  services
}) => {
  if (!state.planned) {
    return failure('internal_error', 'Planned state was not loaded for link.add', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.link.add'
    })
  }
  const committed = state.committed ?? state.planned
  const planned = cloneModel(state.planned)
  const nodeIds = new Set(planned.nodes.map((node) => node.id))
  const addedIds: string[] = []
  for (const item of input.links) {
    if (!nodeIds.has(item.src)) {
      return failure('not_found', `Unknown src node '${item.src}'`, {
        entity: 'node',
        id: item.src,
        field: 'src'
      })
    }
    if (!nodeIds.has(item.dst)) {
      return failure('not_found', `Unknown dst node '${item.dst}'`, {
        entity: 'node',
        id: item.dst,
        field: 'dst'
      })
    }
    const existing = planned.links.find((link) => link.src === item.src && link.dst === item.dst)
    if (existing) {
      return failure('illegal_link', `Duplicate link rejected: ${item.src} -> ${item.dst}`, {
        reason: 'duplicate_link',
        src: item.src,
        dst: item.dst,
        linkId: existing.id
      })
    }
    const violation = linkViolation(planned, item.src, item.dst)
    if (violation) {
      return failure('illegal_link', `Link rejected: ${item.src} -> ${item.dst}`, {
        reason: violation.reason,
        src: item.src,
        dst: item.dst,
        ...(violation.reason === 'duplicate_link' && violation.linkId
          ? { linkId: violation.linkId }
          : {})
      })
    }
    const id = makeLinkId(item.src, item.dst)
    planned.links.push({
      id,
      src: item.src,
      dst: item.dst,
      label: item.label,
      method: item.method
    })
    addedIds.push(id)
  }
  const findings = services.validators.validateModel(planned)
  return success({
    result: {
      addedIds,
      findings,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
