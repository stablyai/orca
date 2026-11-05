import type { ComputerActionResult } from '../../shared/runtime-types'
import { RuntimeClientError } from './runtime-client-error'

export function normalizeComputerActionResult(result: ComputerActionResult): ComputerActionResult {
  const action = result.action
  if (!action) {
    return result
  }
  const verificationReason =
    action.path === 'synthetic'
      ? ('synthetic_input' as const)
      : action.path === 'clipboard'
        ? ('clipboard_paste' as const)
        : action.path === 'accessibility'
          ? ('accessibility_action_unasserted' as const)
          : null
  if (!verificationReason || action.verification) {
    return result
  }
  return {
    ...result,
    action: {
      ...action,
      verification: { state: 'unverified', reason: verificationReason }
    }
  }
}

// Why: a read-back showing another value proves the write failed; returned as ok, callers that check only the exit status took it as success (#33511).
export function rejectContradictedComputerAction(
  result: ComputerActionResult
): ComputerActionResult {
  const verification = result.action?.verification
  if (verification?.state !== 'unverified' || verification.reason !== 'value_mismatch') {
    return result
  }
  const actual =
    typeof verification.actualPreview === 'string'
      ? JSON.stringify(verification.actualPreview)
      : 'a different value'
  throw new RuntimeClientError(
    'verification_failed',
    `set-value did not take effect: after the write the element reads ${actual}, not the requested value`
  )
}
