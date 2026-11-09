import { describe, expect, it } from 'vitest'
import type {
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { chatAutomationRunObservation } from './automation-chat-run-observation'

const sent: AgentJournalSubmission = {
  clientMessageId: 'prompt',
  fence: 1,
  payloadFingerprint: 'hash',
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2
}

function rejected(rejection?: { kind: string }): AgentJournalSnapshot {
  return {
    sessionId: 'codex_chat',
    cursor: { epoch: 'epoch', sequence: 2 },
    items: [],
    submissions: [{ ...sent, dispatchState: 'rejected', ...(rejection ? { rejection } : {}) }]
  }
}

describe('a chat automation run whose agent never started', () => {
  it.each(['hostStopped', 'providerStartFailed', 'startFailed'])(
    'says the agent did not start when its prompt was rejected as %s',
    (kind) => {
      expect(chatAutomationRunObservation(rejected({ kind }), 'prompt', 'Codex')).toEqual({
        status: 'dispatch_failed',
        error: expect.stringMatching(/^Codex did not start \(the machine may have slept/)
      })
    }
  )

  it('keeps the unconfirmed-prompt error for other rejections', () => {
    for (const snapshot of [rejected({ kind: 'notSignedIn' }), rejected()]) {
      expect(chatAutomationRunObservation(snapshot, 'prompt', 'Codex')?.error).toBe(
        "Codex could not confirm this run's prompt. Open the chat before running it again."
      )
    }
  })
})
