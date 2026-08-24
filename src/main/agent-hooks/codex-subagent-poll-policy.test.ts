import { describe, expect, it } from 'vitest'

import {
  advanceCodexSubagentPollPlan,
  CODEX_SUBAGENT_POLL_ACTIVE_MS,
  CODEX_SUBAGENT_POLL_QUIET_MAX_MS,
  INITIAL_CODEX_SUBAGENT_POLL_PLAN
} from './codex-subagent-poll-policy'

describe('Codex subagent poll policy', () => {
  it('backs off quiet polls to a bounded cadence', () => {
    const first = advanceCodexSubagentPollPlan(INITIAL_CODEX_SUBAGENT_POLL_PLAN, true)
    expect(first).toEqual({ delayMs: 2_000 })

    const second = advanceCodexSubagentPollPlan(first, true)
    expect(second).toEqual({ delayMs: 4_000 })

    const capped = advanceCodexSubagentPollPlan(second, true)
    expect(capped).toEqual({ delayMs: CODEX_SUBAGENT_POLL_QUIET_MAX_MS })
    expect(advanceCodexSubagentPollPlan(capped, true)).toEqual({
      delayMs: CODEX_SUBAGENT_POLL_QUIET_MAX_MS
    })
  })

  it('restores the active cadence when activity returns', () => {
    const quiet = advanceCodexSubagentPollPlan(INITIAL_CODEX_SUBAGENT_POLL_PLAN, true)

    expect(advanceCodexSubagentPollPlan(quiet, false)).toEqual({
      delayMs: CODEX_SUBAGENT_POLL_ACTIVE_MS
    })
  })
})
