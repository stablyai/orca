/** The `allow-stale-base` spec opt-out and the drift threshold it overrides. */

// Why (§3.1): 20 lets normal monorepo day-velocity pass but trips the 168-commit harm from ORCHESTRATOR_FEEDBACK.md (chosen in msg_eff3a646110d).
export const DISPATCH_STALE_THRESHOLD = 20

// Why (§3.4): the flag lives in the spec text (no DB column in v1); the regex is narrow so typos fail closed, and stripping keeps the infra line out of the worker's `--- TASK ---` block.
// Trade-off (§7.9): matches any spec line, even inside fenced code — fails open, but the preamble drift section still surfaces staleness to the worker.
const ALLOW_STALE_BASE_RE = /^[ \t]*allow-stale-base:[ \t]*true[ \t]*\r?$/im
const ALLOW_STALE_BASE_STRIP_RE = /^[ \t]*allow-stale-base:[ \t]*true[ \t]*\r?\n?/im

export function parseAllowStaleBaseFromSpec(spec: string): {
  allowStale: boolean
  strippedSpec: string
} {
  if (!ALLOW_STALE_BASE_RE.test(spec)) {
    return { allowStale: false, strippedSpec: spec }
  }
  const strippedSpec = spec.replace(ALLOW_STALE_BASE_STRIP_RE, '')
  return { allowStale: true, strippedSpec }
}
