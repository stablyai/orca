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
  it.each([
    'The provider did not accept this message: provider_write_failed: stand-in rejected the turn.',
    'The provider stopped before it finished starting.',
    'The provider did not accept this message.'
  ])('normalizes legacy host wording with the chat’s agent: %s', (reason) => {
    const notices = mobileNativeChatUnsentNotices(
      { items: [], submissions: [rejected({ reason })] },
      'codex'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Codex didn't accept this message."
    )
  })
  it('names the agent with a resend step after the host classifies an unwritten send', () => {
    const rejection: AgentSessionFailureFact = {
      kind: 'writeFailed',
      detail: { text: 'provider_write_failed: stand-in rejected the turn.', audience: 'log' }
    }
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [],
        submissions: [rejected({ rejection })]
      },
      'codex'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Codex couldn't receive this message. Send it again."
    )
  })

  it('never shows the stand-in marker from a previously misclassified fact', () => {
    const text = 'provider_write_failed: stand-in rejected the turn.'
    const rejection: AgentSessionFailureFact = {
      kind: 'providerRejected',
      detail: { text, audience: 'person' }
    }
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [],
        submissions: [rejected({ rejection })]
      },
      'codex'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Codex didn't accept this message."
    )
  })

  it("says why, in the host's words, keyed by the message's row", () => {
    const notices = mobileNativeChatUnsentNotices(
      { items: [], submissions: [rejected()] },
      'claude'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(
      "Claude couldn't receive this message. Send it again."
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

  it.each([
    [
      'keeps the sign-in steps when only a subagent row states them',
      'child-1',
      "Codex isn't signed in. Run `codex login`."
    ],
    [
      'says only that it was not sent under a visible sign-in row',
      undefined,
      'Your message was not sent.'
    ]
  ])('%s', (_name, agentId, expected) => {
    const notSignedIn: AgentSessionFailureFact = { kind: 'notSignedIn' }
    const authRow: AgentJournalRenderItem = {
      itemId: 'auth-row',
      ...(agentId ? { agentId } : {}),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(notSignedIn, { agentName: 'Codex', surface: 'row' })
      }
    }
    const notices = mobileNativeChatUnsentNotices(
      {
        items: [authRow],
        submissions: [rejected({ reason: 'Written by the host.', rejection: notSignedIn })]
      },
      'codex'
    )
    expect(notices.get(agentJournalSubmissionKey('sent-elsewhere'))).toBe(expected)
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
