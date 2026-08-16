export const CODEX_SUBAGENT_POLL_ACTIVE_MS = 1_000
// Why: cap delayed-child discovery lag while cutting steady quiet polling by 80%.
export const CODEX_SUBAGENT_POLL_QUIET_MAX_MS = 5_000

export type CodexSubagentPollPlan = Readonly<{
  delayMs: number
}>

export const INITIAL_CODEX_SUBAGENT_POLL_PLAN: CodexSubagentPollPlan = Object.freeze({
  delayMs: CODEX_SUBAGENT_POLL_ACTIVE_MS
})

export function advanceCodexSubagentPollPlan(
  current: CodexSubagentPollPlan,
  quiet: boolean
): CodexSubagentPollPlan {
  if (!quiet) {
    return INITIAL_CODEX_SUBAGENT_POLL_PLAN
  }
  return {
    delayMs: Math.min(current.delayMs * 2, CODEX_SUBAGENT_POLL_QUIET_MAX_MS)
  }
}
