import { expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { endRepliedTurn, type ChatTurnEnd } from './external-conversation-turn-ends'
import type { ConversationReplyFill } from './external-conversation-reply-fill'

it("keeps a failed turn's reason on its state-only end, which the cloud stores for the thread", async () => {
  const emit = vi.fn()
  const end: ChatTurnEnd = {
    ended: {
      kind: 'turn-ended',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      paneKey: 'pane',
      worktreeId: 'wt',
      turnId: 1,
      stopReason: 'failure',
      at: 2
    },
    news: {
      kind: 'turn-ended',
      sessionId: 'chat-1',
      outcome: 'failure',
      readTurn: async () => ({}),
      at: 2
    },
    agent: 'claude',
    emit,
    workersChecked: async () => undefined,
    current: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only externalId and bot.
  const link = { externalId: 'slack:T1:C1:1.2' } as ExternalConversationLink
  const stamp = {
    account: 'a',
    conversation: { source: 'slack' as const, externalId: link.externalId },
    deliveryId: 'd1'
  }
  const told = await endRepliedTurn(
    end,
    {
      turnItemId: 'item:turn-1',
      stamps: [stamp],
      failure: agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 9_000 } })
    },
    link,
    async () => [],
    async () => new Set([link.externalId])
  )
  expect(told).toBe(true)
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      stateOnly: true,
      failure: expect.objectContaining({
        category: 'usage_limit',
        agentName: 'Claude',
        usageLimit: { resetsAt: 9_000 }
      })
    })
  )
})

it('fills an answered turn with how long it ran, by its own start and end', async () => {
  const fill = vi.fn<ConversationReplyFill>(async () => new Set(['slack:T1:C1:1.2']))
  const end: ChatTurnEnd = {
    ended: {
      kind: 'turn-ended',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      paneKey: 'pane',
      worktreeId: 'wt',
      turnId: 1_000,
      stopReason: 'success',
      at: 99_000
    },
    news: {
      kind: 'turn-ended',
      sessionId: 'chat-1',
      outcome: 'success',
      readTurn: async () => ({}),
      at: 99_000
    },
    agent: 'claude',
    emit: vi.fn(),
    workersChecked: async () => undefined,
    current: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only externalId and bot.
  const link = { externalId: 'slack:T1:C1:1.2' } as ExternalConversationLink
  const turn = {
    turnItemId: 'item:turn-1',
    stamps: [
      {
        account: 'a',
        conversation: { source: 'slack' as const, externalId: link.externalId },
        deliveryId: 'd1'
      }
    ]
  }
  await endRepliedTurn(end, turn, link, async () => [], fill)
  expect(fill).toHaveBeenLastCalledWith(expect.objectContaining({ tookMs: 98_000 }))
  // A turn whose start predates this watch has no length to give.
  await endRepliedTurn(
    { ...end, ended: { ...end.ended, turnId: null } },
    turn,
    link,
    async () => [],
    fill
  )
  expect(fill.mock.lastCall?.[0]).not.toHaveProperty('tookMs')
})
