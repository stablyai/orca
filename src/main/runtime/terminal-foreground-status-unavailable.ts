import { isClientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'

/**
 * True when inspect could not read foreground membership.
 * Covers the legacy `unavailable: true` host shape and current pre-v11
 * `verdict: unverifiable` answers (#12946).
 */
export function isTerminalForegroundInspectionUnavailable(inspection: unknown): boolean {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return true
  }
  return (
    typeof inspection === 'object' &&
    inspection !== null &&
    (inspection as { unavailable?: unknown }).unavailable === true
  )
}
