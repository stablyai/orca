import { parsePaneKey } from '../../../shared/stable-pane-id'
import { OrchestrationError } from '../orchestration/orchestration-error'

export function equivalentLegacyPaneKey(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) {
    return false
  }
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

export function legacyReadOnlyError(): OrchestrationError {
  return new OrchestrationError(
    'legacy_read_only',
    'This retained legacy assignment could not prove authority from its original live process. No effects were applied.',
    { effectsApplied: false }
  )
}

export function legacyCoordinatorReadOnly(): OrchestrationError {
  return new OrchestrationError(
    'legacy_read_only',
    'This retained legacy coordinator could not prove its original process identity. No effects were applied.',
    { effectsApplied: false }
  )
}
