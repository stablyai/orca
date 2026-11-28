import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import {
  createBotAutomationDispatcher,
  type BotAutomationSessions,
  type BotRunResults
} from './bot-automation-launch'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
const bot = { id: 'b1', name: 'Ranger', agent: 'claude', members: [] } as unknown as Bot

async function promptOf(target: NonNullable<Automation['bot']>): Promise<string> {
  const send = { sessionId: 'run-chat', clientMessageId: 'm1', fingerprint: 'f' }
  const sessions = {
    startConversation: vi.fn<BotAutomationSessions['startConversation']>(async () => send),
    sendToBotChat: vi.fn<BotAutomationSessions['sendToBotChat']>(async () => send),
    sendToSession: vi.fn(async () => send),
    sendToChat: vi.fn(async () => send),
    release: vi.fn(async () => {})
  } satisfies BotAutomationSessions
  const results: BotRunResults = {
    watch: async () => ({
      next: async () => ({ outcome: 'success', message: 'Done.' }),
      dispose: () => {}
    }),
    deliver: async () => ({ status: 'completed', outputSnapshot: null }),
    couldNotStart: () => {}
  }
  const launched = await createBotAutomationDispatcher(
    sessions,
    results
  )({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    automation: {
      id: 'a1',
      name: 'Redo',
      prompt: 'Redo the review.',
      dtstart: 1,
      bot: target
    } as Automation,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    run: { id: 'r1', trigger: 'scheduled', title: 'Redo', scheduledFor: 1 } as AutomationRun,
    target: { ok: true, cwd: '/b', bot, workspaceId: 'w1', runsIn: target.runsIn }
  })
  await launched.completion
  return (
    sessions.startConversation.mock.calls[0]?.[1].text ?? sessions.sendToBotChat.mock.calls[0]![2]
  )
}

describe("a bot run's prompt", () => {
  it('ends with where its final message goes', async () => {
    expect(
      await promptOf({
        botId: 'b1',
        runsIn: 'chat',
        chat: { sessionId: 's1', homeIfGone: true, toConversation: true },
        resultsTo: 'chat',
        originThread: {
          source: 'slack',
          externalId: 'T1:C1:1.2',
          place: '#design',
          sessionId: 's1'
        }
      })
    ).toBe(
      'Redo the review.\n\n[Orca: Your final message posts as a reply in the Slack thread in #design.]'
    )
    expect(
      await promptOf({ botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C9', label: '#news' } })
    ).toBe('Redo the review.\n\n[Orca: Your final message posts as a new top-level post in #news.]')
  })
})
