import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    const none = {
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      quietRepeatedStop: false,
      statusFeed: false
    }
    expect(structuredAgentSessionHostSupport([])).toEqual(none)
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, questionAnswers: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, promptCancel: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedMessages: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, quietRepeatedStop: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, statusFeed: true })
  })
})
