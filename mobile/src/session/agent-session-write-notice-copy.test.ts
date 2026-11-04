import { describe, expect, it } from 'vitest'
import { agentSessionWriteNoticeParts } from '../../../src/shared/agent-session/failures/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from '../../../src/shared/agent-session/failures/agent-session-write-failure'
import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'

describe('mobileAgentSessionWriteNoticeText', () => {
  it('names the attachment an expired refusal lists, as its card labels it', () => {
    const failure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachmentExpired',
        expiredAttachments: [{ uploadId: 'upload-1', name: 'notes.pdf' }]
      }
    })
    expect(
      mobileAgentSessionWriteNoticeText(agentSessionWriteNoticeParts(failure, 'composer-send'))
    ).toBe('notes.pdf expired. Your message was not sent. Remove it and attach it again.')
  })
})
