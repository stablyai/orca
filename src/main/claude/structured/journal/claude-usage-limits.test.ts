import { expect, it } from 'vitest'
import { ClaudeUsageLimits } from './claude-usage-limits'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'

const NOW = Date.parse('2026-10-15T00:00:00.000Z')
const POOLED_TEXT =
  'API Error: Request rejected (429) · All available accounts have exhausted a shared session or weekly usage limit. Remaining model-specific capacity (including Fable) cannot be used until a shared limit resets. Earliest reset at 2026-10-15T01:39:59.530Z.'

// The result frame a pooled-accounts 429 ends a turn with, as logged (trimmed to what is read).
const pooledResult = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  terminal_reason: 'api_error',
  result: POOLED_TEXT
}

it('reads a pooled-accounts 429 as a usage limit with its earliest reset', () => {
  const row = new ClaudeUsageLimits(() => NOW).result(pooledResult, true, null)
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    kind: 'usageLimitReached',
    usageLimit: { resetsAt: Date.parse('2026-10-15T01:39:59.530Z') }
  })
})

it('reads the pooled 429 even after an assistant error typed it as another cause', () => {
  const row = new ClaudeUsageLimits(() => NOW).result(pooledResult, true, { cause: 'other' })
  expect(readAgentSessionFailureFact(row?.failure)?.kind).toBe('usageLimitReached')
})

it('leaves an ordinary 429 that names no limit alone', () => {
  const row = new ClaudeUsageLimits(() => NOW).result(
    { ...pooledResult, result: 'API Error: Request rejected (429) · overloaded' },
    true,
    { cause: 'other' }
  )
  expect(row).toBeNull()
})

it("prefers the pool's earliest reset over an older rejection still cached", () => {
  const limits = new ClaudeUsageLimits(() => NOW)
  // A session limit rejected earlier, resetting later than the pool says it frees up.
  limits.observe({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: NOW / 1000 + 4 * 3600
    }
  })
  const row = limits.result(pooledResult, true, null)
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    usageLimit: { resetsAt: Date.parse('2026-10-15T01:39:59.530Z') }
  })
})
