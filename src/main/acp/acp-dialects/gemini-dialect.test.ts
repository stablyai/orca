import { describe, expect, it } from 'vitest'
import { AcpAgentError } from '../transport/acp-errors'
import { acpPromptFailureEnding } from '../turns/acp-prompt-failure'
import { GEMINI_ACP_DIALECT } from './gemini-dialect'

// Gemini CLI 0.68.0 rejects a failed prompt with the model API's HTTP status as its code.
describe('GEMINI_ACP_DIALECT prompt failures', () => {
  it('ends a rate-limited prompt as a usage limit', () => {
    const error = new AcpAgentError(429, 'Rate limit exceeded. Try again later.')
    expect(acpPromptFailureEnding(GEMINI_ACP_DIALECT, error, 0)).toMatchObject({
      stopReason: 'rate_limit',
      notSignedIn: false
    })
  })

  it('reads an unauthorized prompt as signed out', () => {
    const error = new AcpAgentError(401, 'Request had invalid authentication credentials.')
    expect(acpPromptFailureEnding(GEMINI_ACP_DIALECT, error, 0)).toMatchObject({
      stopReason: 'error',
      notSignedIn: true
    })
  })
})
