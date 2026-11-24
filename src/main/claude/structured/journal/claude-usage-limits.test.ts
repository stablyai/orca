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

// The assistant frame a subscription limit ends a turn with when the CLI sends no typed api_error.
const limitAssistant = (text: string) => ({
  type: 'assistant',
  error: 'rate_limit',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text }] }
})

it("reads the CLI's own limit line as a usage limit, with a rejection's reset", () => {
  const limits = new ClaudeUsageLimits(() => NOW)
  limits.observe({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 3600 }
  })
  const row = limits.assistant(
    limitAssistant('You’ve hit your session limit · resets 1am (America/New_York)')
  )
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    kind: 'usageLimitReached',
    usageLimit: { window: 'session', resetsAt: NOW + 3600 * 1000 }
  })
})

it('reads the reset from the line itself when no rejection was seen, in the zone it names', () => {
  // NOW is 8pm in New York, so 3pm there is the next afternoon.
  const row = new ClaudeUsageLimits(() => NOW).assistant(
    limitAssistant('You’ve hit your session limit · resets 3pm (America/New_York)')
  )
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    kind: 'usageLimitReached',
    usageLimit: { window: 'session', resetsAt: Date.parse('2026-10-15T19:00:00.000Z') }
  })
})

it('reads a reset a few days out, with its minutes', () => {
  const row = new ClaudeUsageLimits(() => NOW).assistant(
    limitAssistant("You've hit your weekly limit · resets Oct 17, 9:30am (America/New_York)")
  )
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    usageLimit: { window: 'weekly', resetsAt: Date.parse('2026-10-17T13:30:00.000Z') }
  })
})

it("never lets the result's limit line override a login failure the turn already typed", () => {
  const row = new ClaudeUsageLimits(() => NOW).result(
    { type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" },
    true,
    { cause: 'other' }
  )
  expect(row).toBeNull()
})

it("reads an older CLI's limit line with its reset epoch", () => {
  const row = new ClaudeUsageLimits(() => NOW).assistant(
    limitAssistant(`Claude AI usage limit reached|${NOW / 1000 + 7200}`)
  )
  expect(readAgentSessionFailureFact(row?.failure)).toMatchObject({
    kind: 'usageLimitReached',
    usageLimit: { resetsAt: NOW + 7200 * 1000 }
  })
})

it('leaves prose about limits that is no rate-limit error alone', () => {
  const row = new ClaudeUsageLimits(() => NOW).assistant({
    ...limitAssistant("You've hit your limit on retries, so I stopped."),
    error: undefined
  })
  expect(row).toBeNull()
})
