import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as BotTurnFor from '../../../../bots/bot-turn-for'

// Whom the run acts for, and which bot's home a session is in, come from records this test doesn't
// build; the caller check (sameSession) stays real.
vi.mock('../../../../bots/bot-turn-for', async (actual) => ({
  ...(await actual<typeof BotTurnFor>()),
  botTurnFor: async () => 'owner'
}))
const sessionBot = vi.hoisted((): { id: string | null } => ({ id: 'b1' }))
vi.mock('../../../../bots/bot-session-tabs', () => ({
  botOfSession: () => (sessionBot.id ? { id: sessionBot.id } : null)
}))

import { runRoutes } from '../../../../automations/bot-run-thread-posts'
import { CONNECTOR_METHODS } from './connector'

const THREAD = { source: 'slack', externalId: 'T1:C08NLB8LXCP:1795700000.000100' } as const
const PAGE = '```html\n<!doctype html><html><body><h1>Review</h1></body></html>\n```'
const RUN_BOT = { id: 'b1', folderWorkspaceId: 'w1', name: 'Ranger' }

function replyFrom(options: {
  bot: Record<string, unknown>
  trigger?: string
  verified?: string
  botsOn?: boolean
  pagesAsFiles?: boolean
}) {
  const reply = vi.fn(async () => ({ ok: true, value: {} }))
  const runtime = {
    // The run's own conversation is linked to no thread.
    getExternalConversationSeam: () => ({ replyTarget: () => null }),
    listAutomationRuns: () => [
      {
        automationId: 'a1',
        chatSessionId: 'run-conv',
        status: 'dispatched',
        trigger: options.trigger ?? 'scheduled'
      }
    ],
    showAutomation: () => ({ bot: options.bot }),
    bots: { enabled: () => options.botsOn ?? true, list: () => [RUN_BOT] },
    getConnectorCloud: () => ({
      cloudFeatures: () =>
        new Set(options.pagesAsFiles ? ['actions', 'files.direct', 'reply.files'] : []),
      reply
    })
  }
  const method = CONNECTOR_METHODS.find((entry) => entry.name === 'connector.reply')!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed params, as the schema passes them
  const params = {
    sessionId: 'run-conv',
    replyId: 'p1',
    text: options.pagesAsFiles ? PAGE : 'Halfway there.',
    ...(options.pagesAsFiles ? { pagesAsFiles: true } : {})
  } as never
  const caller = options.verified ? { kind: 'session', sessionId: options.verified } : undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members and the caller
  const context = { runtime, orchestrationCaller: caller } as never
  return { reply, call: () => method.handler(params, context) }
}

const OWN_AGENT = {
  botId: 'b1',
  runsIn: 'new',
  agentSetup: { agent: 'codex' },
  resultsTo: 'thread',
  originThread: { ...THREAD, place: '#ui-ux-design', sessionId: 'thread-chat' }
}

const ROUTED = {
  botId: 'b1',
  threadPost: { conversation: THREAD, place: 'the Slack thread in #ui-ux-design' },
  sentence: 'Your final message posts as a reply in the Slack thread in #ui-ux-design.'
}

let release = () => {}
afterEach(() => {
  release()
  sessionBot.id = 'b1'
})

describe('bot reply from a run posting into a thread from its own conversation', () => {
  it('posts where the dispatcher routed this run', async () => {
    release = runRoutes.start('run-conv', ROUTED)
    const { reply, call } = replyFrom({ bot: OWN_AGENT, verified: 'run-conv' })
    await expect(call()).resolves.toMatchObject({ place: 'the Slack thread in #ui-ux-design' })
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyId: 'p1',
        text: 'Halfway there.',
        conversation: expect.objectContaining(THREAD)
      })
    )
  })

  it("is refused from any session but the run's own, or another bot's", async () => {
    release = runRoutes.start('run-conv', ROUTED)
    for (const verified of [undefined, 'someone-else']) {
      const { reply, call } = replyFrom({ bot: OWN_AGENT, verified })
      await expect(call()).rejects.toThrow()
      expect(reply).not.toHaveBeenCalled()
    }
    sessionBot.id = 'b2'
    const { reply, call } = replyFrom({ bot: OWN_AGENT, verified: 'run-conv' })
    await expect(call()).rejects.toThrow()
    expect(reply).not.toHaveBeenCalled()
  })

  it('stays out of the thread for a run by hand, saying its result stays in Orca', async () => {
    // A manual run is routed out of the thread, so nothing registers it.
    const { reply, call } = replyFrom({ bot: OWN_AGENT, trigger: 'manual', verified: 'run-conv' })
    await expect(call()).rejects.toThrow(
      'Your final message stays in Orca, in this conversation: nothing posts it anywhere.'
    )
    expect(reply).not.toHaveBeenCalled()
  })

  it('is refused, naming the place, when the run posts elsewhere', async () => {
    const { reply, call } = replyFrom({
      bot: { ...OWN_AGENT, resultsTo: { channel: 'C0NEWS', label: '#news' } },
      verified: 'run-conv'
    })
    await expect(call()).rejects.toThrow(
      'Your final message posts as a new top-level post in #news.'
    )
    expect(reply).not.toHaveBeenCalled()
  })

  it('is refused while bots are off, and sends nothing', async () => {
    release = runRoutes.start('run-conv', ROUTED)
    const { reply, call } = replyFrom({ bot: OWN_AGENT, verified: 'run-conv', botsOn: false })
    await expect(call()).rejects.toThrow()
    expect(reply).not.toHaveBeenCalled()
  })

  it("posts a page as text: files need the thread's own chat", async () => {
    release = runRoutes.start('run-conv', ROUTED)
    const { reply, call } = replyFrom({ bot: OWN_AGENT, verified: 'run-conv', pagesAsFiles: true })
    await expect(call()).resolves.toMatchObject({ place: 'the Slack thread in #ui-ux-design' })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('names where this run posts even after its automation was edited mid-run', async () => {
    release = runRoutes.start('run-conv', {
      botId: 'b1',
      sentence: 'Your final message posts as a new top-level post in #news.'
    })
    // The saved automation now says something else; the run keeps its own route.
    const { call } = replyFrom({ bot: { ...OWN_AGENT, resultsTo: 'none' }, verified: 'run-conv' })
    await expect(call()).rejects.toThrow(
      'Your final message posts as a new top-level post in #news.'
    )
  })
})
