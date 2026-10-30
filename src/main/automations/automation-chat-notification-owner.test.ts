import { describe, expect, it, vi } from 'vitest'
import { ownsAutomationChatCompletion } from './automation-chat-notification-owner'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletion } from '../../shared/agent-session-wire'
import type { AutomationRunReceipt } from './automation-run-receipt'

const completion: AgentSessionTurnCompletion = {
  sessionId: 'chat',
  turnId: 'root',
  outcome: 'success',
  completedAt: 3,
  scope: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'git-worktree'
  }
}
const receipt: AutomationRunReceipt = {
  kind: 'chat',
  accepted: true,
  sessionId: 'chat',
  workspaceId: 'workspace',
  messageId: 'prompt'
}
const snapshot: AgentJournalSnapshot = {
  sessionId: 'chat',
  cursor: { epoch: 'epoch', sequence: 2 },
  submissions: [
    {
      clientMessageId: 'prompt',
      fence: 1,
      payloadFingerprint: 'hash',
      dispatchState: 'accepted',
      providerItemId: 'provider-user',
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
  ],
  items: [
    {
      itemId: 'root',
      sequence: 2,
      revision: 1,
      observedAt: 3,
      body: {
        kind: 'turn',
        turnId: 'provider-turn',
        userItemId: 'provider-user',
        state: 'completed',
        outcome: 'success'
      }
    }
  ]
}
function deps() {
  return {
    settleDispatches: async () => {},
    runs: () => buildProfileStateCutoverFixture().automationRuns,
    receipt: () => receipt,
    snapshot: vi.fn(async () => snapshot)
  }
}
describe('automation Chat notification ownership', () => {
  it('suppresses only the accepted root, preserving later human turns and other workspace/session completions', async () => {
    const input = deps()
    expect(await ownsAutomationChatCompletion(completion, input)).toBe(true)
    expect(await ownsAutomationChatCompletion({ ...completion, turnId: 'human' }, input)).toBe(
      false
    )
    expect(await ownsAutomationChatCompletion({ ...completion, sessionId: 'other' }, input)).toBe(
      false
    )
    expect(
      await ownsAutomationChatCompletion(
        { ...completion, scope: { ...completion.scope, workspaceId: 'other' } },
        input
      )
    ).toBe(false)
    expect(input.snapshot).toHaveBeenCalledTimes(2)
  })
  it('waits for launch acceptance when the first turn finishes before dispatch returns', async () => {
    const accepted = Promise.withResolvers<void>()
    let published: AutomationRunReceipt | null = null
    const input = { ...deps(), settleDispatches: () => accepted.promise, receipt: () => published }
    const pending = ownsAutomationChatCompletion(completion, input)
    await Promise.resolve()
    expect(input.snapshot).not.toHaveBeenCalled()
    published = receipt
    accepted.resolve()
    expect(await pending).toBe(true)
  })
})
