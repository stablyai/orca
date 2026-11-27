import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import type { BotRunResult } from '../bots/bot-run-results'
import {
  createBotAutomationDispatcher,
  type BotAutomationSessions,
  type BotRunResults
} from './bot-automation-launch'

const ORIGIN = { source: 'slack', externalId: 'T1:C1:1700000000.000100', place: '#design' } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
const bot = { id: 'b1', name: 'Ranger', agent: 'claude', members: [] } as unknown as Bot

function dispatch(
  automation: Partial<Automation>,
  trigger: AutomationRun['trigger'] = 'scheduled'
) {
  const send = { sessionId: 'run-chat', clientMessageId: 'm1', fingerprint: 'f' }
  const sessions = {
    startConversation: vi.fn<BotAutomationSessions['startConversation']>(async () => send),
    sendToBotChat: vi.fn(async () => send),
    sendToSession: vi.fn(async () => send),
    sendToChat: vi.fn(async () => send),
    release: vi.fn(async () => {})
  } satisfies BotAutomationSessions
  let delivered: BotRunResult | undefined
  const results: BotRunResults = {
    watch: async () => ({
      next: async () => ({ outcome: 'success', message: 'Redone.' }),
      dispose: () => {}
    }),
    deliver: async (result) => {
      delivered = result
      return { status: 'completed', outputSnapshot: null }
    },
    couldNotStart: () => {}
  }
  const launch = createBotAutomationDispatcher(sessions, results)
  return {
    sessions,
    run: async () => {
      const launched = await launch({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
        automation: {
          id: 'a1',
          name: 'Redo the review',
          prompt: 'Redo the review.',
          dtstart: 1,
          ...automation
        } as Automation,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
        run: { id: 'r1', trigger, title: 'Redo the review', scheduledFor: 1 } as AutomationRun,
        target: { ok: true, cwd: '/b', bot, workspaceId: 'w1', runsIn: automation.bot!.runsIn }
      })
      await launched.completion
      return delivered!
    }
  }
}

describe('a run of an automation made answering a thread', () => {
  it('posts its result into that thread from its own conversation', async () => {
    const { sessions, run } = dispatch({
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN }
    })
    const result = await run()
    expect(result.target).toMatchObject({
      resultsTo: 'thread',
      threadPost: { source: 'slack', externalId: ORIGIN.externalId }
    })
    // It started this conversation, so it lets it go once the result is posted.
    expect(sessions.release).toHaveBeenCalledWith('run-chat')
  })

  it('tells the run where its final message goes', async () => {
    const { sessions, run } = dispatch({
      bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C9', label: '#news' } }
    })
    await run()
    expect(sessions.startConversation.mock.calls[0]![1].text).toBe(
      'Redo the review.\n\n[Orca: Your final message posts as a new top-level post in #news.]'
    )
  })

  it('keeps a run started by hand out of the thread, and says so', async () => {
    const { sessions, run } = dispatch(
      { bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN } },
      'manual'
    )
    const result = await run()
    expect(result.target.resultsTo).toBe('none')
    expect(sessions.startConversation.mock.calls[0]![1].text).toContain(
      '[Orca: Your final message stays in Orca, in this conversation: nothing posts it anywhere.]'
    )
  })
})
