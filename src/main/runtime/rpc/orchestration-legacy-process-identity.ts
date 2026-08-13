import { isEquivalentPaneKey } from '../../../shared/stable-pane-id'
import { OrchestrationError } from '../orchestration/orchestration-error'

// Why: legacy rows carry nullable pane keys, and a missing key is never proof of
// identity — so absence is refused here rather than inside the shared comparison.
export function equivalentLegacyPaneKey(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) {
    return false
  }
  return isEquivalentPaneKey(a, b)
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
