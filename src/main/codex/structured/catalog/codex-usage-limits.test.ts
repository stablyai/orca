import { expect, it } from 'vitest'
import { CodexUsageLimits } from './codex-usage-limits'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'

// Codex writes the time in its own local zone, which is this process's zone on the same host.
const NOW = new Date(2026, 10, 22, 14, 0).getTime()

function resetOf(message: string, limits = new CodexUsageLimits(() => NOW, true)) {
  const fact = readAgentSessionFailureFact(
    limits.failure({ error: { message, codexErrorInfo: 'usageLimitExceeded' } })
  )
  return fact?.kind === 'usageLimitReached' ? fact.usageLimit?.resetsAt : 'not a usage limit'
}

it('only reports explicit usage limit errors when the account report shows quota left', () => {
  const limits = new CodexUsageLimits(() => NOW)
  limits.observe('notification:account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      secondary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: NOW / 1000 + 3600 }
    }
  })

  expect(
    limits.failure({
      error: { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }
    })
  ).toBeNull()
  expect(limits.failure({ error: { codexErrorInfo: 'rateLimitExceeded' } })).toBeNull()
  expect(limits.failure({ error: { codexErrorInfo: 'usageLimitExceeded' } })).toMatchObject({
    kind: 'usageLimitReached'
  })
})

it("reads the reset Codex's error text names when no report gave one", () => {
  const plus =
    'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM.'
  // The text drops seconds, so the reset is read as the end of the named minute.
  expect(resetOf(plus)).toBe(new Date(2026, 10, 22, 15, 6).getTime())
  expect(resetOf('You’ve hit your usage limit. Try again at Nov 23rd, 2026 12:30 AM.')).toBe(
    new Date(2026, 10, 23, 0, 31).getTime()
  )
  expect(resetOf('You’ve hit your usage limit. Try again at Dec 1st, 2026 11:00 PM.')).toBe(
    new Date(2026, 11, 1, 23, 1).getTime()
  )
})

it('never guesses a reset the text does not name exactly', () => {
  for (const message of [
    'You’ve hit your usage limit. Try again later.',
    'You’ve hit your usage limit. Try again at Feb 30th, 2027 3:05 PM.',
    'You’ve hit your usage limit. Try again at 13:05 PM.',
    // Earlier today: not a reset still to come.
    'You’ve hit your usage limit. Try again at 9:15 AM.'
  ]) {
    expect(resetOf(message)).toBeUndefined()
  }
})

it("keeps the report's reset over the text's", () => {
  const limits = new CodexUsageLimits(() => NOW, true)
  const reported = new Date(2026, 10, 22, 16, 0).getTime()
  limits.observe('notification:account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: reported / 1000 }
    }
  })
  expect(resetOf('You’ve hit your usage limit. Try again at 3:05 PM.', limits)).toBe(reported)
})

it("ignores the text's time when Codex runs elsewhere (WSL, SSH, a remote host)", () => {
  const elsewhere = new CodexUsageLimits(() => NOW, false)
  expect(resetOf('You’ve hit your usage limit. Try again at 3:05 PM.', elsewhere)).toBeUndefined()
})
