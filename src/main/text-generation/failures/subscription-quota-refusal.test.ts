import { describe, expect, it } from 'vitest'
import { isSubscriptionQuotaRefusal } from './subscription-quota-refusal'

const NOW = Date.parse('2026-11-20T04:00:00Z')
const output = (stdout: string, stderr = '', exitCode: number | null = 1) => ({
  label: 'agent',
  exitCode,
  stdout,
  stderr
})

// Captured from Claude Code 2.1.317 and Codex 0.166.0 runs refused for subscription quota.
const CLAUDE_LIMIT = "You've hit your 5-hour limit · resets 5:09am (UTC)\n"
const CODEX_LIMIT =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:15 AM.'

describe('isSubscriptionQuotaRefusal', () => {
  it('accepts only the CLI limit line from a failed exit', () => {
    const cases: [string, ReturnType<typeof output>, boolean][] = [
      ['claude', output(CLAUDE_LIMIT), true],
      ['claude', output('Claude AI usage limit reached|1795064400\n'), true],
      ['codex', output('', `[2026-11-20T04:00:00] ERROR: ${CODEX_LIMIT}\n`), true],
      ['codex', output('', `ERROR: ${CODEX_LIMIT}\n`), true],
      // A successful answer that quotes the line is the model's prose.
      ['claude', output(CLAUDE_LIMIT, '', 0), false],
      ['codex', output('', `note: ${CODEX_LIMIT}`), false],
      ['claude', output('API Error: 500 Internal server error\n'), false],
      ['claude', output(CLAUDE_LIMIT, '', null), false],
      ['gemini', output(CLAUDE_LIMIT), false]
    ]
    for (const [agentId, failure, expected] of cases) {
      expect(
        isSubscriptionQuotaRefusal(agentId, failure, NOW),
        `${agentId}: ${failure.stdout}${failure.stderr}`
      ).toBe(expected)
    }
  })
})
