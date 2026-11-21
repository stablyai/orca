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
    async () => ({ covered: new Set([link.externalId]), paused: false })
  )
  expect(told).toBe('told')
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
  const fill = vi.fn<ConversationReplyFill>(async () => ({
    covered: new Set(['slack:T1:C1:1.2']),
    paused: false
  }))
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

it('ends a Slack turn its stamps name state-only even when its rows are already gone, never with its answer', async () => {
  const run = async (source: 'slack' | 'github', fill: ConversationReplyFill) => {
    const emit = vi.fn()
    const externalId = `${source}:thread`
    const end: ChatTurnEnd = {
      ended: {
        kind: 'turn-ended',
        conversation: { source, externalId },
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only source, externalId and bot.
    const link = { source, externalId } as ExternalConversationLink
    const told = await endRepliedTurn(
      end,
      {
        turnItemId: 'item:turn-1',
        stamps: [{ account: 'a', conversation: { source, externalId }, deliveryId: 'd1' }],
        turnProse: 'Done.'
      },
      link,
      async () => [],
      fill
    )
    return { told, emitted: emit.mock.calls.map(([event]) => event.stateOnly === true) }
  }
  // Recovery already filled, sent and deleted its rows: the fill covers nothing.
  expect(await run('slack', async () => ({ covered: new Set<string>(), paused: false }))).toEqual({
    told: 'told',
    emitted: [true]
  })
  // The fill failed: recovery drains the rows; the thread still never gets a full end.
  expect(
    await run('slack', async () => {
      throw new Error('journal busy')
    })
  ).toEqual({ told: 'told', emitted: [true] })
  // Sources outside the outbox keep their full end.
  expect(await run('github', async () => ({ covered: new Set<string>(), paused: false }))).toEqual({
    told: 'not-covered',
    emitted: []
  })
})

it('says a paused turn resumes at the time the scheduler shows, and promises none it does not', async () => {
  const run = async (resumesAt?: number) => {
    const emit = vi.fn<ChatTurnEnd['emit']>()
    const conversation = { source: 'slack' as const, externalId: 'slack:T1:C1:1.2' }
    await endRepliedTurn(
      {
        ended: {
          kind: 'turn-ended',
          conversation,
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
      },
      {
        turnItemId: 'item:turn-1',
        stamps: [{ account: 'a', conversation, deliveryId: 'd1' }],
        failure: agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 9_000 } })
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only source, externalId and bot.
      conversation as ExternalConversationLink,
      async () => [],
      async () => ({
        covered: new Set([conversation.externalId]),
        paused: true,
        ...(resumesAt === undefined ? {} : { resumesAt })
      })
    )
    const [event] = emit.mock.calls[0]!
    return event.kind === 'turn-ended'
      ? { resumes: event.resumes, resetsAt: event.failure?.usageLimit?.resetsAt }
      : null
  }
  // An account hold moved the continue past the reset: the line says the later time.
  expect(await run(12_000)).toEqual({ resumes: true, resetsAt: 12_000 })
  // The app shows no time (an unknown reset): no promise, the thread stays Working.
  expect(await run()).toEqual({ resumes: undefined, resetsAt: 9_000 })
})

it('says whether the outbox may still post the answer, so the legacy end never posts it too', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const endOf = (source: 'slack' | 'github', externalId: string): ChatTurnEnd => ({
    ended: {
      kind: 'turn-ended',
      conversation: { source, externalId },
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
    emit: vi.fn(),
    turnFor: () => ({}),
    workersChecked: async () => undefined,
    current: () => true
  })
  const replied = (source: 'slack' | 'github', externalId: string) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replied end reads only source, externalId and bot.
    const link = { source, externalId } as ExternalConversationLink
    const stamps = [{ account: 'a', conversation: { source, externalId }, deliveryId: 'd1' }]
    return {
      end: endOf(source, externalId),
      link,
      stamps,
      turn: { turnItemId: 'item:turn-1', stamps }
    }
  }
  const none = async () => []
  const threw: ConversationReplyFill = async () => {
    throw new Error('database is locked')
  }
  const dm = replied('slack', 'T1:D7:D7:U9')
  // No outbox at all: only the legacy end can tell the DM.
  expect(await endRepliedTurn(dm.end, dm.turn, dm.link, none, undefined)).toBe('not-covered')
  // A turn whose row is unknown leaves rows recovery will still post.
  expect(await endRepliedTurn(dm.end, { stamps: dm.stamps }, dm.link, none, threw)).toBe('unsafe')
  // The outbox covers it, or a reset meanwhile means the end reaches no one: nothing more to tell.
  expect(
    await endRepliedTurn(dm.end, dm.turn, dm.link, none, async () => ({
      covered: new Set([dm.link.externalId]),
      paused: false
    }))
  ).toBe('told')
  expect(
    await endRepliedTurn({ ...dm.end, current: () => false }, dm.turn, dm.link, none, threw)
  ).toBe('told')
  // A merged quiet turn's constant goes out on the legacy end; the rows keep the words.
  expect(
    await endRepliedTurn(
      dm.end,
      dm.turn,
      dm.link,
      none,
      async () => ({ covered: new Set([dm.link.externalId]), paused: false }),
      'I replied but…'
    )
  ).toBe('unsafe')
  // Unless its rows answer there with words: nothing was dropped, so no stand-in goes out.
  expect(
    await endRepliedTurn(
      dm.end,
      dm.turn,
      dm.link,
      none,
      async () => ({
        covered: new Set([dm.link.externalId]),
        paused: false,
        answered: new Set([dm.link.externalId])
      }),
      'I replied but…'
    )
  ).toBe('told')
  // Outside the outbox: a fill covering another conversation leaves only the legacy end; one that
  // threw leaves rows recovery may post.
  const issue = replied('github', 'github:o/r#1')
  expect(
    await endRepliedTurn(issue.end, issue.turn, issue.link, none, async () => ({
      covered: new Set(['other']),
      paused: false
    }))
  ).toBe('not-covered')
  expect(await endRepliedTurn(issue.end, issue.turn, issue.link, none, threw)).toBe('unsafe')
  warn.mockRestore()
})
