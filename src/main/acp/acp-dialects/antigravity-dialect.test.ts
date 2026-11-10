import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import { acpPromptErrorDetail } from '../turns/acp-prompt-failure'
import { AcpAgentError } from '../transport/acp-errors'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

const QUOTA_MESSAGE =
  'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h42m11s.'

function cloudCodeAssistEnvelope(body: unknown): string {
  return `Cloud Code Assist API error (429): ${JSON.stringify(body)}`
}

function quotaEnvelope(): string {
  return cloudCodeAssistEnvelope({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ reason: 'RATE_LIMIT_EXCEEDED', padding: 'x'.repeat(600) }],
      message: QUOTA_MESSAGE
    }
  })
}

describe('Antigravity Cloud Code Assist chat errors', () => {
  it('shows the provider message instead of the JSON envelope', () => {
    const raw = quotaEnvelope()
    expect(raw.length).toBeGreaterThan(MAX_PROVIDER_DIAGNOSTIC_CHARS)
    const bounded = providerDiagnostic(raw, 'person')
    expect(bounded?.text.includes(QUOTA_MESSAGE)).toBe(false)
    expect(bounded?.text.length).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_CHARS)

    expect(acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, raw))).toBe(
      QUOTA_MESSAGE
    )
  })

  it('keeps the raw text when the envelope cannot be parsed', () => {
    const truncated = 'Cloud Code Assist API error (429): {"error": {"message":'
    const unrelated = 'Authentication required'
    const missingMessage = cloudCodeAssistEnvelope({ error: { code: 429 } })
    const blankMessage = cloudCodeAssistEnvelope({ error: { message: '   ' } })
    const otherJson = `request failed: ${JSON.stringify({ error: { message: QUOTA_MESSAGE } })}`

    expect(
      acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, truncated))
    ).toBe(truncated)
    expect(
      acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, unrelated))
    ).toBe(unrelated)
    expect(
      acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, missingMessage))
    ).toBe(missingMessage)
    expect(
      acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, blankMessage))
    ).toBe(blankMessage)
    expect(
      acpPromptErrorDetail(ANTIGRAVITY_ACP_DIALECT, new AcpAgentError(-32603, otherJson))
    ).toBe(otherJson)
  })
})
