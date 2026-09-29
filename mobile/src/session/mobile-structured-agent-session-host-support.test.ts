import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    expect(structuredAgentSessionHostSupport([])).toEqual({
      promptCancel: false,
      questionAnswers: false
    })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({ promptCancel: false, questionAnswers: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({ promptCancel: true, questionAnswers: false })
  })
})
