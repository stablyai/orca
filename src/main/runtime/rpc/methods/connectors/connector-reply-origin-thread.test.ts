import { describe, expect, it, vi } from 'vitest'

// Who the run acts for and whose session it is come from records this test doesn't build.
vi.mock('../../../../bots/bot-turn-for', () => ({ botTurnFor: async () => 'owner' }))
vi.mock('../../../../bots/bot-session-tabs', () => ({ botOfSession: () => ({ id: 'b1' }) }))

import { CONNECTOR_METHODS } from './connector'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C08NLB8LXCP:1795700000.000100',
  place: '#ui-ux-design',
  sessionId: 'thread-chat'
} as const

function replyFrom(bot: Record<string, unknown>) {
  const reply = vi.fn(async () => ({ ok: true, value: {} }))
  const runtime = {
    // The run's own conversation is linked to no thread.
    getExternalConversationSeam: () => ({ replyTarget: () => null }),
    listAutomationRuns: () => [
      { automationId: 'a1', chatSessionId: 'run-conv', status: 'dispatched' }
    ],
    showAutomation: () => ({ bot }),
    bots: { enabled: () => false, list: () => [] },
    getConnectorCloud: () => ({ cloudFeatures: () => new Set(), reply })
  }
  const method = CONNECTOR_METHODS.find((entry) => entry.name === 'connector.reply')!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed params, as the schema passes them
  const params = { sessionId: 'run-conv', replyId: 'p1', text: 'Halfway there.' } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members
  const context = { runtime } as never
  const call = () => method.handler(params, context)
  return { reply, call }
}

describe('bot reply from a run that posts its result into the thread it was made in', () => {
  it('posts into that thread while the run works', async () => {
    const { reply, call } = replyFrom({
      botId: 'b1',
      runsIn: 'new',
      agentSetup: { agent: 'codex' },
      resultsTo: 'thread',
      originThread: ORIGIN
    })
    await expect(call()).resolves.toMatchObject({ place: 'the Slack thread in #ui-ux-design' })
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyId: 'p1',
        text: 'Halfway there.',
        conversation: expect.objectContaining({ source: 'slack', externalId: ORIGIN.externalId })
      })
    )
  })

  it('is refused, naming the place, when the run posts elsewhere', async () => {
    const { reply, call } = replyFrom({
      botId: 'b1',
      runsIn: 'new',
      resultsTo: { channel: 'C0NEWS', label: '#news' },
      originThread: ORIGIN
    })
    await expect(call()).rejects.toThrow(
      'Your final message posts as a new top-level post in #news.'
    )
    expect(reply).not.toHaveBeenCalled()
  })
})
