import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { Bot } from '../../shared/bot-types'
import type { BotRunResult } from '../bots/bot-run-results'
import {
  createBotAutomationDispatcher,
  type BotAutomationSessions,
  type BotRunResults,
  type BotRunThreads
} from './bot-automation-launch'
import { runRoutes, type RunRoute } from './bot-run-thread-posts'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C1:1700000000.000100',
  place: '#design',
  sessionId: 'thread-chat'
} as const
const ORIGIN_KEY = { source: 'slack', externalId: ORIGIN.externalId }
const EVENT_THREAD = { source: 'slack', externalId: 'T1:C2:1800000000.000100' } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
const bot = { id: 'b1', name: 'Ranger', agent: 'claude', members: [] } as unknown as Bot

type Harness = {
  trigger?: AutomationRun['trigger']
  event?: Record<string, unknown>
  /** Each takesMail answer in turn; the last repeats. */
  takesMail?: boolean[]
  /** What sending to the thread's chat does: send, find it gone, or fail. */
  openChat?: 'send' | 'gone' | 'throws'
  /** Whether the cloud bound the run's own conversation to its event's thread. */
  adopts?: boolean
}

function dispatch(automation: Partial<Automation>, harness: Harness = {}) {
  const trigger = harness.trigger ?? 'scheduled'
  const answers = [...(harness.takesMail ?? [true])]
  const calls: string[] = []
  const send = { sessionId: 'run-chat', clientMessageId: 'm1', fingerprint: 'f' }
  const sent = (name: string) => async () => {
    calls.push(name)
    return send
  }
  const sessions = {
    startConversation: vi.fn<BotAutomationSessions['startConversation']>(sent('startConversation')),
    sendToBotChat: vi.fn(sent('sendToBotChat')),
    sendToSession: vi.fn(sent('sendToSession')),
    sendToChat: vi.fn(sent('sendToChat')),
    release: vi.fn(async () => {}),
    takesMail: vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]!)),
    sendToOpenChat: vi.fn<NonNullable<BotAutomationSessions['sendToOpenChat']>>(async () => {
      calls.push('sendToOpenChat')
      if (harness.openChat === 'throws') {
        throw new Error('the chat closed')
      }
      return harness.openChat === 'gone' ? null : send
    })
  } satisfies BotAutomationSessions
  const threads: BotRunThreads = { adopt: () => harness.adopts ?? false }
  let delivered: BotRunResult | undefined
  let live: RunRoute | undefined
  const couldNotStart = vi.fn()
  const results: BotRunResults = {
    watch: async () => ({
      next: async () => {
        live = runRoutes.of('run-chat')
        return { outcome: 'success', message: 'Redone.' }
      },
      dispose: () => {}
    }),
    deliver: async (result) => {
      delivered = result
      return { status: 'completed', outputSnapshot: null }
    },
    couldNotStart
  }
  const launch = createBotAutomationDispatcher(sessions, results, threads)
  const textSent = () =>
    [
      ...sessions.sendToOpenChat.mock.calls.map((call) => call[2]),
      ...sessions.startConversation.mock.calls.map((call) => call[1].text)
    ].at(-1)
  return {
    sessions,
    calls,
    couldNotStart,
    textSent,
    live: () => live,
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
        run: {
          id: 'r1',
          trigger,
          title: 'Redo the review',
          scheduledFor: 1,
          ...(harness.event
            ? {
                event: {
                  source: 'slack',
                  event: 'message',
                  key: 'k1',
                  occurredAt: 1,
                  ...harness.event
                }
              }
            : {})
        } as AutomationRun,
        target: { ok: true, cwd: '/b', bot, workspaceId: 'w1', runsIn: automation.bot!.runsIn }
      })
      await launched.completion
      return delivered!
    }
  }
}

const OWN_AGENT = {
  botId: 'b1',
  runsIn: 'new',
  agentSetup: { agent: 'codex' },
  resultsTo: 'thread',
  originThread: ORIGIN
} as const

describe('a run that posts into the thread its automation was made in', () => {
  it('posts its result there, and its live replies go there too', async () => {
    const h = dispatch({ bot: OWN_AGENT })
    const result = await h.run()
    expect(result.target).toMatchObject({ resultsTo: 'thread', threadPost: ORIGIN_KEY })
    expect(h.live()).toEqual({
      botId: 'b1',
      threadPost: { conversation: ORIGIN_KEY, place: 'the Slack thread in #design' },
      sentence: 'Your final message posts as a reply in the Slack thread in #design.'
    })
    // Only while it runs; it started this conversation, so it lets it go after.
    expect(runRoutes.of('run-chat')).toBeUndefined()
    expect(h.sessions.release).toHaveBeenCalledWith('run-chat')
  })

  it('tells the run where its final message goes', async () => {
    const h = dispatch({
      bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C9', label: '#news' } }
    })
    await h.run()
    expect(h.textSent()).toBe(
      'Redo the review.\n\n[Orca: Your final message posts as a new top-level post in #news.]'
    )
    expect(h.live()?.sentence).toBe('Your final message posts as a new top-level post in #news.')
  })

  it('keeps a run started by hand out of the thread, its live replies included', async () => {
    const h = dispatch({ bot: OWN_AGENT }, { trigger: 'manual' })
    const result = await h.run()
    expect(result.target.resultsTo).toBe('none')
    expect(h.live()).toEqual({
      botId: 'b1',
      sentence: 'Your final message stays in Orca, in this conversation: nothing posts it anywhere.'
    })
  })
})

describe('an event run of an automation made answering a thread', () => {
  const watch: Partial<Automation> = {
    on: [{ id: 'e1', source: 'slack', event: 'message' }],
    once: { by: 2 },
    bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN }
  }

  it('answers the thread it was made in at its deadline, whatever event it last saw', async () => {
    const h = dispatch(watch, { event: { conversation: EVENT_THREAD } })
    const result = await h.run()
    expect(result.target).toMatchObject({ threadPost: ORIGIN_KEY })
  })

  it('answers its own event thread when the event brought one', async () => {
    const h = dispatch(watch, {
      trigger: 'event',
      event: { conversation: EVENT_THREAD },
      adopts: true
    })
    const result = await h.run()
    expect(result.target).toEqual({ runsIn: 'new', resultsTo: 'thread', letBotReact: false })
    // Linked to the event's thread, so its replies go through that link, not a post route.
    expect(h.live()?.threadPost).toBeUndefined()
  })

  it('answers a Linear event on its issue, not the Slack thread it was made in', async () => {
    const h = dispatch(watch, {
      trigger: 'event',
      event: { source: 'linear', event: 'commented', subject: 'ENG-42' }
    })
    const result = await h.run()
    expect(result.target.resultsTo).toEqual({ linearIssue: 'ENG-42' })
    expect(result.target.threadPost).toBeUndefined()
  })

  it('answers the thread it was made in for an event with no thread of its own', async () => {
    const h = dispatch(watch, { trigger: 'event', event: {} })
    const result = await h.run()
    expect(result.target).toMatchObject({ threadPost: ORIGIN_KEY })
  })
})

const IN_ORIGIN_CHAT = {
  botId: 'b1',
  runsIn: 'chat',
  chat: { sessionId: 'thread-chat', homeIfGone: true, toConversation: true },
  resultsTo: 'chat',
  originThread: ORIGIN
} as const

const PROVENANCE =
  '[Orca: start your final message with this line, as written: _From the automation “Redo the review”, created in this thread._]'

const GONE_TO_THREAD = { runsIn: 'new', resultsTo: 'thread', threadPost: ORIGIN_KEY }

describe('a run in the chat that answers its thread', () => {
  it('is delivered there, with no extra line for a recurring one', async () => {
    const h = dispatch({ bot: IN_ORIGIN_CHAT })
    await h.run()
    expect(h.calls).toEqual(['sendToOpenChat'])
    expect(h.textSent()).not.toContain('start your final message')
  })

  it('has a wait open its answer with where it came from', async () => {
    const h = dispatch({ bot: IN_ORIGIN_CHAT, once: { by: 2 } })
    await h.run()
    expect(h.calls).toEqual(['sendToOpenChat'])
    expect(h.textSent()).toContain(PROVENANCE)
    expect(h.live()?.sentence).toBe(
      'Your final message posts as a reply in the Slack thread in #design.'
    )
  })

  it('posts into the thread from one new conversation when the chat closed before the run', async () => {
    const h = dispatch({ bot: IN_ORIGIN_CHAT, once: { by: 2 } }, { openChat: 'gone' })
    const result = await h.run()
    expect(h.calls).toEqual(['sendToOpenChat', 'startConversation'])
    expect(h.sessions.sendToBotChat).not.toHaveBeenCalled()
    expect(h.sessions.sendToChat).not.toHaveBeenCalled()
    expect(result.target).toMatchObject(GONE_TO_THREAD)
    // Orca puts the line on its own post, so the new conversation isn't told to write it, and its
    // message no longer claims the gone chat's thread turn.
    expect(h.textSent()).not.toContain('start your final message')
    expect(
      h.sessions.startConversation.mock.calls[0]![1].run?.automationRun?.toConversation
    ).toBeUndefined()
    expect(h.sessions.release).toHaveBeenCalledWith('run-chat')
  })

  it('does the same when the chat closes while its prompt goes', async () => {
    const h = dispatch({ bot: IN_ORIGIN_CHAT }, { takesMail: [false], openChat: 'throws' })
    const result = await h.run()
    expect(h.calls).toEqual(['sendToOpenChat', 'startConversation'])
    expect(result.target).toMatchObject(GONE_TO_THREAD)
  })

  it('fails the run, not reroutes it, when an open chat refuses the prompt', async () => {
    const h = dispatch({ bot: IN_ORIGIN_CHAT }, { takesMail: [true], openChat: 'throws' })
    await expect(h.run()).rejects.toThrow('the chat closed')
    expect(h.couldNotStart).toHaveBeenCalled()
    expect(h.sessions.startConversation).not.toHaveBeenCalled()
  })

  it.each([
    [{ channel: 'C9', label: '#news' }, 'a new top-level post in #news'],
    [{ linearIssue: 'ENG-7' }, 'a comment on ENG-7']
  ] as const)('keeps the copy to %o when the chat is gone', async (copyTo, words) => {
    const h = dispatch({ bot: { ...IN_ORIGIN_CHAT, resultsTo: copyTo } }, { openChat: 'gone' })
    const result = await h.run()
    expect(result.target).toMatchObject({ ...GONE_TO_THREAD, copyTo })
    expect(h.live()?.sentence).toBe(
      `Your final message posts as a reply in the Slack thread in #design, and a copy posts as ${words}.`
    )
  })

  it.each([
    ['with the chat it continues', IN_ORIGIN_CHAT],
    [
      'with toConversation alone',
      { ...IN_ORIGIN_CHAT, chat: { sessionId: 'thread-chat', toConversation: true } }
    ]
  ] as const)(
    'finds the chat of a target saved before the thread kept it, %s',
    async (_label, saved) => {
      const { sessionId: _kept, ...older } = ORIGIN
      const h = dispatch({ bot: { ...saved, originThread: older }, once: { by: 2 } })
      await h.run()
      expect(h.sessions.sendToOpenChat.mock.calls[0]![1]).toBe('thread-chat')
      expect(h.textSent()).toContain(PROVENANCE)
    }
  )

  it('leaves another chat chosen by id to its own lookup', async () => {
    const h = dispatch({ bot: { ...IN_ORIGIN_CHAT, chat: { sessionId: 'other' } } })
    await h.run()
    expect(h.calls).toEqual(['sendToBotChat'])
  })
})
