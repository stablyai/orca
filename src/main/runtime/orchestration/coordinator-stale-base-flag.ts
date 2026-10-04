/** The `allow-stale-base` spec opt-out and the drift threshold it overrides. */
import { parseTaskSpecFlag } from './task-spec-flag'

// Why (§3.1): 20 lets normal monorepo day-velocity pass but trips the 168-commit harm from ORCHESTRATOR_FEEDBACK.md (chosen in msg_eff3a646110d).
export const DISPATCH_STALE_THRESHOLD = 20

// Why: a fenced-code match fails open, but the preamble drift section still surfaces staleness to the worker.
export function parseAllowStaleBaseFromSpec(spec: string): {
  allowStale: boolean
  strippedSpec: string
} {
  const { enabled, strippedSpec } = parseTaskSpecFlag(spec, 'allow-stale-base')
  return { allowStale: enabled, strippedSpec }
}
