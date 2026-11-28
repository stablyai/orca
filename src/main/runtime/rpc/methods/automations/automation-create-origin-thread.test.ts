import { describe, expect, it, vi } from 'vitest'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C08NLB8LXCP:1795700000.000100',
  place: '#ui-ux-design',
  sessionId: 'thread-chat'
} as const

// The caller's chat answers that thread; reading it needs the live connector seam.
vi.mock('./creator-thread', () => ({ creatorThreadOf: async () => ORIGIN }))
vi.mock('../../../automation-saved-card', () => ({ recordAutomationSavedCard: () => {} }))

import { AUTOMATION_METHODS } from './automations'

// What the host saves: the routed target, as the runtime would after its lookups.
const ROUTED = {
  botId: 'b1',
  runsIn: 'chat',
  chat: { sessionId: 'thread-chat', homeIfGone: true, toConversation: true },
  resultsTo: 'chat',
  originThread: ORIGIN
}

async function create(params: Record<string, unknown>, verified?: string) {
  const createAutomation = vi.fn(async (input: { bot?: { originThread?: unknown } }) => ({
    id: 'a1',
    ...input,
    bot: input.bot?.originThread ? ROUTED : input.bot
  }))
  const runtime = {
    createAutomation,
    lookAround: { botOfLook: () => null },
    bots: { list: () => [] }
  }
  const method = AUTOMATION_METHODS.find((entry) => entry.name === 'automation.create')!
  const orchestrationCaller = verified ? { kind: 'session', sessionId: verified } : undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members and the caller
  const context = { runtime, orchestrationCaller } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed params, as the schema passes them
  const parsed = { callerSessionId: 'thread-chat', ...params } as never
  const answer: { notes?: string[] } = await method.handler(parsed, context)
  return { saved: createAutomation.mock.calls[0]![0], notes: answer.notes }
}

const REDO = {
  name: 'Redo the review',
  prompt: 'Redo the review.',
  bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C08NLB8LXCP' } },
  once: { by: 2 }
}

describe('creating a bot automation while answering a thread', () => {
  it('records the thread, and notes the flags it overrode', async () => {
    const { saved, notes } = await create(REDO, 'thread-chat')
    expect(saved.bot).toEqual({ ...REDO.bot, originThread: ORIGIN })
    expect(notes).toEqual([
      "Made while answering the Slack thread in #ui-ux-design, so it runs in this chat and replies there: this overrode --runs-in and --results-to (--results-to named this thread's own channel). To post in a different channel instead, name that channel with --results-to channel:<channel>."
    ])
  })

  it('notes nothing for flags the caller left out', async () => {
    const { notes } = await create(
      {
        ...REDO,
        bot: { botId: 'b1', runsIn: 'chat', resultsTo: 'chat' },
        runsInDefault: true,
        resultsToDefault: true
      },
      'thread-chat'
    )
    expect(notes).toBeUndefined()
  })

  it('records no thread unless Orca verified the request came from that chat', async () => {
    for (const verified of [undefined, 'another-chat']) {
      expect((await create(REDO, verified)).saved.bot).toEqual(REDO.bot)
    }
  })

  it('records no thread on one events start', async () => {
    const watch = { ...REDO, on: [{ id: 'e1', source: 'slack', event: 'message' }] }
    expect((await create(watch, 'thread-chat')).saved.bot).toEqual(REDO.bot)
  })
})
