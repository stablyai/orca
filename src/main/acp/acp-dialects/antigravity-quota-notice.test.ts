import { expect, it } from 'vitest'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import { AcpAgentError } from '../transport/acp-errors'
import { acpPromptFailureEnding } from '../turns/acp-prompt-failure'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

const AT = Date.UTC(2026, 10, 26, 12, 0, 0)
const HOUR = 3_600_000

function limitOf(text: string) {
  const lane = new AcpTimelineTranslator({
    sessionId: 'root',
    dialect: ANTIGRAVITY_ACP_DIALECT,
    agentName: 'Antigravity'
  })
  lane.openPrompt('prompt-1', 1)
  const rows = lane
    .notification(
      'session/update',
      {
        sessionId: 'root',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
      },
      AT
    )
    .flatMap((event) =>
      event.type === 'item.update' && event.body.kind === 'status' ? [event.body] : []
    )
  const fact = readAgentSessionFailureFact(rows[0]?.failure)
  return fact?.kind === 'usageLimitReached' ? (fact.usageLimit ?? {}) : null
}

it("reads agy's quota notices as usage limits, resetting when they say, and nothing else", () => {
  const individual =
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in'
  expect(limitOf(`\n${individual} 2h30m0s.\n`)).toEqual({ resetsAt: AT + 2.5 * HOUR })
  expect(limitOf(`\n${individual} 4 hours, 5 minutes.\n`)).toEqual({
    resetsAt: AT + 4 * HOUR + 5 * 60_000
  })
  expect(limitOf('\n⚠ You have exhausted your quota on this model.\n')).toEqual({})
  expect(
    limitOf(
      '⚠ agent executor error: generating and executing: Error 429, Message: You exceeded your current quota, please check your plan and billing details. Please retry in 56.5s., Status: RESOURCE_EXHAUSTED, Details: []'
    )
  ).toEqual({ resetsAt: AT + 56_500 })
  // The model's own words and other agy notices are not a usage limit.
  expect(limitOf('Individual quota reached. Resets in 2h.')).toBeNull()
  expect(limitOf('⚠ Your app got RESOURCE_EXHAUSTED; retry in 1m.')).toBeNull()
  expect(
    limitOf('⚠ agent executor error: open /tmp/x: disc quota exceeded, Status: INTERNAL')
  ).toBeNull()

  const refused = new AcpAgentError(-32603, 'Internal error', {
    details:
      'Cloud Code Assist API error (429): {"error":{"code":429,"message":"Individual quota reached. Resets in 1h.","status":"RESOURCE_EXHAUSTED"}}'
  })
  const ending = acpPromptFailureEnding(ANTIGRAVITY_ACP_DIALECT, refused, AT)
  expect([ending.stopReason, ending.usageLimit]).toEqual(['rate_limit', { resetsAt: AT + HOUR }])
})
