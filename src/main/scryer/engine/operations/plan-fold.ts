import type {
  ScryerFoldTarget,
  ScryerOperationExecutor,
  ScryerPlanFoldInput,
  ScryerPlanFoldResult
} from '../types'
import { diffModels } from '../diff'
import { failure, success } from './helpers'

function selectors(input: ScryerPlanFoldInput): ScryerFoldTarget[] {
  const targets: ScryerFoldTarget[] = []
  const hasSubselectors =
    (input.responsibility_ids?.length ?? 0) > 0 ||
    (input.property_labels?.length ?? 0) > 0 ||
    (input.properties?.length ?? 0) > 0 ||
    (input.link_ids?.length ?? 0) > 0 ||
    (input.group_ids?.length ?? 0) > 0
  if (input.node_id && (input.all === true || !hasSubselectors)) {
    targets.push({
      kind: 'node',
      node_id: input.node_id,
      includeDescendants: input.include_descendants
    })
  }
  for (const responsibility_id of input.responsibility_ids ?? []) {
    targets.push({ kind: 'responsibility', responsibility_id })
  }
  for (const label of input.property_labels ?? []) {
    if (input.node_id) {
      targets.push({ kind: 'property', node_id: input.node_id, label })
    }
  }
  for (const property of input.properties ?? []) {
    targets.push({ kind: 'property', node_id: property.node_id, label: property.label })
  }
  for (const link_id of input.link_ids ?? []) {
    targets.push({ kind: 'link', link_id })
  }
  for (const group_id of input.group_ids ?? []) {
    targets.push({ kind: 'group', group_id })
  }
  return targets
}

export const planFoldOperation: ScryerOperationExecutor<
  ScryerPlanFoldInput,
  ScryerPlanFoldResult
> = ({ input, state, services }) => {
  if (!state.committed || !state.planned) {
    return failure('internal_error', 'Committed and planned state were not loaded for plan.fold', {
      reason: 'policy_violation',
      contractOperationId: 'scryer.plan.fold'
    })
  }
  const targets = selectors(input)
  if (targets.length === 0) {
    return failure('invalid_input', 'plan.fold requires at least one fold selector', undefined, {
      fieldErrors: [
        {
          path: 'node_id',
          message: 'provide a node, responsibility, link, group, or property selector'
        }
      ]
    })
  }
  const pending = diffModels(state.committed, state.planned)
  const pendingKeys = new Set(
    pending.map((change) =>
      change.kind === 'property'
        ? `property:${change.ownerId}:${change.id}`
        : `${change.kind}:${change.id}`
    )
  )
  const missingTargets = targets.filter((target) => {
    switch (target.kind) {
      case 'node':
        return !pendingKeys.has(`node:${target.node_id}`)
      case 'responsibility':
        return !pendingKeys.has(`responsibility:${target.responsibility_id}`)
      case 'property':
        return !pendingKeys.has(`property:${target.node_id}:${target.label}`)
      case 'link':
        return !pendingKeys.has(`link:${target.link_id}`)
      case 'group':
        return !pendingKeys.has(`group:${target.group_id}`)
    }
  })
  if (missingTargets.length > 0) {
    return failure('validation_failed', 'Selected fold target is not pending work', {
      findings: missingTargets.map((target) => ({
        code: 'missing_reference',
        severity: 'error',
        message: `Selected ${target.kind} fold target is not pending`,
        path: 'model',
        details: {
          entity: target.kind === 'responsibility' ? 'responsibility' : target.kind,
          id:
            target.kind === 'node'
              ? target.node_id
              : target.kind === 'responsibility'
                ? target.responsibility_id
                : target.kind === 'property'
                  ? target.label
                  : target.kind === 'link'
                    ? target.link_id
                    : target.group_id,
          field: 'foldTarget'
        }
      }))
    })
  }
  const foldedState = services.fold.foldTargets({
    committed: state.committed,
    planned: state.planned,
    targets
  })
  const findings = services.validators.validateModel(foldedState.committed)
  const remaining = diffModels(foldedState.committed, foldedState.planned)
  return success({
    result: {
      folded: foldedState.folded,
      remaining,
      findings
    },
    changes: {
      committed: foldedState.committed,
      planned: foldedState.planned,
      baseline: 'refresh',
      historyEvents: [
        {
          operationId: 'scryer.plan.fold',
          folded: foldedState.folded,
          mode: input.mode ?? 'manual',
          timestamp: services.clock.nowIso()
        }
      ]
    },
    meta: {
      completionGate: {
        complete:
          remaining.length === 0 &&
          findings.filter((finding) => finding.severity === 'error').length === 0,
        pendingCount: remaining.length,
        validationWarningCount: findings.filter((finding) => finding.severity === 'warning').length,
        validationErrorCount: findings.filter((finding) => finding.severity === 'error').length
      }
    }
  })
}
