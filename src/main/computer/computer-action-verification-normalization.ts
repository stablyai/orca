import type { ComputerActionResult } from '../../shared/runtime-types'

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
