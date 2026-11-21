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
    turnFor: () => ({}),
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
    current: () => true,
    turnFor: () => ({})
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

it('tells a heard restart continuation’s state only: reply recovery posts its answer, once', async () => {
  // A thread that heard the continuation's turn (adopted after the restart) would post its words
  // under the turn's key while recovery posts the same answer under the original request's.
  const emit = vi.fn()
  const end: ChatTurnEnd = {
    ended: {
      kind: 'turn-ended',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      paneKey: 'pane',
      worktreeId: 'wt',
      turnId: 1,
      stopReason: 'success',
      at: 2
    },
    news: {
      kind: 'turn-ended',
      sessionId: 'chat-1',
      outcome: 'success',
      readTurn: async () => ({}),
      at: 2
    },
    agent: 'claude',
    emit,
    turnFor: () => ({}),
    workersChecked: async () => undefined,
    current: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only externalId and bot.
  const link = { externalId: 'slack:T1:C1:1.2' } as ExternalConversationLink
  const continuation = {
    turnItemId: 'item:turn-2',
    stamps: [],
    lastAssistantMessage: 'Deployed.',
    opener: {
      itemId: 'orca:c1',
      revision: 1,
      sequence: 3,
      observedAt: 3,
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Orca restarted. Resume.' }],
        restartOf: { kind: 'turn' as const, id: 'turn-1' }
      }
    }
  }
  const fill = vi.fn<ConversationReplyFill>(async () => new Set<string>())
  expect(await endRepliedTurn(end, continuation, link, async () => [], fill)).toBe(true)
  expect(emit).toHaveBeenCalledTimes(1)
  expect(emit.mock.lastCall?.[0]).toMatchObject({ stateOnly: true })
  expect(emit.mock.lastCall?.[0]).not.toHaveProperty('lastAssistantMessage')
  // The Slack mirror holds it: the mirror tells its words, and recovery closes the request quietly.
  expect(
    await endRepliedTurn({ ...end, mirrored: true }, continuation, link, async () => [], fill)
  ).toBe(false)
  // No reply outbox: the turn end is the only way the answer goes, as before.
  expect(await endRepliedTurn(end, continuation, link, async () => [], null)).toBe(false)
  expect(emit).toHaveBeenCalledTimes(1)
})
