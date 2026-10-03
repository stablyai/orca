import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../src/shared/structured-agent-session-start-failure-row-key'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'

function rejected(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: 'sent-elsewhere',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'provider_write_failed: broken pipe',
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

describe('the line under a message the host recorded and did not deliver', () => {
  it("says why, in the host's words, keyed by the message's row", () => {
    const notices = mobileNativeChatUnsentNotices(
      { items: [], submissions: [rejected()] },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Orca couldn't reach the agent. Your message was not sent."
    )
  })

  it('says only that it was not sent when the start-failure row already says why', () => {
    const startFailed: AgentSessionFailureFact = { kind: 'startFailed' }
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
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [startRow],
        submissions: [rejected({ reason: 'Written by the host.', rejection: startFailed })]
      },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      'Your message was not sent.'
    )
  })

  it('has nothing to say when no send was rejected', () => {
    expect(
      mobileNativeChatUnsentNotices(
        { items: [], submissions: [rejected({ dispatchState: 'accepted' })] },
        'claude'
      ).size
    ).toBe(0)
    expect(mobileNativeChatUnsentNotices(null, 'claude').size).toBe(0)
  })
})
