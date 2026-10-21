import { describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../src/shared/agent-session-journal-item-key'
import type { AgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../src/shared/structured-agent-session-start-failure-row-key'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'

function submission(
  clientMessageId: string,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...patch
  }
}

const startFailed: AgentSessionFailureFact = {
  kind: 'startFailed',
  refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
}

const startRow: AgentJournalRenderItem = {
  itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen')),
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'status',
    tone: 'error',
    ...agentSessionFailureWords(startFailed, { agentName: 'Claude', surface: 'row' })
  }
}

describe("the phone's line under a not-sent message", () => {
  it("words each rejected message as the desktop does, naming the chat's agent", () => {
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [],
        submissions: [
          submission('lost', { rejection: startFailed }),
          submission('sent', { dispatchState: 'accepted' })
        ]
      },
      'claude'
    )
    expect(Object.fromEntries(notices)).toEqual({
      [agentJournalSubmissionKey('lost')]: "Claude couldn't start. Start a new chat to continue."
    })
  })

  it('says only that it was not sent when a loaded row already says why', () => {
    const notices = mobileNativeChatUnsentNotices(
      { items: [startRow], submissions: [submission('lost', { rejection: startFailed })] },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('lost'))).toBe('Your message was not sent.')
  })

  it('gives one shared empty map when no send failed, a Stop taking one back included', () => {
    const accepted = {
      items: [],
      submissions: [
        submission('sent', { dispatchState: 'accepted' }),
        submission('stopped', { reason: DISPATCH_REJECTED_CANCELLED })
      ]
    }
    expect(mobileNativeChatUnsentNotices(accepted, 'claude').size).toBe(0)
    expect(mobileNativeChatUnsentNotices(accepted, 'claude')).toBe(
      mobileNativeChatUnsentNotices(null, 'claude')
    )
  })
})
