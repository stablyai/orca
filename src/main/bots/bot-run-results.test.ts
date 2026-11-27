import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { normalizeLoadedAutomationRuns } from '../persistence/loading-store/profile-loading/normalize-loaded-state-collections'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'
import {
  deliverBotRunResult,
  type BotRunDeliveryDependencies,
  type BotRunResult
} from './bot-run-results'

const NOTICE =
  "This run's message was answered together with another message, so its result wasn't posted."

describe('a run answered together with another message', () => {
  it('completes: its prompt was handled in the turn that answered it', async () => {
    const completion = await deliverBotRunResult(
      {} as BotRunDeliveryDependencies,
      {
        ended: { unavailable: 'shared' }
      } as BotRunResult
    )
    expect(completion).toEqual({ status: 'completed', outputSnapshot: null, error: NOTICE })
  })

  it('reads as completed when an older build stored it as failed', () => {
    const run = {
      id: 'r1',
      automationId: 'a1',
      runNumber: 25,
      status: 'dispatch_failed',
      error: NOTICE,
      createdAt: 1,
      scheduledFor: 1
    } as AutomationRun
    const other = { ...run, id: 'r2', runNumber: 26, error: 'Could not start.' }
    let saved = false
    const runs = normalizeLoadedAutomationRuns(
      { automationRuns: [run, other] } as PersistedState,
      () => (saved = true)
    )
    expect(runs.map((r) => r.status)).toEqual(['completed', 'dispatch_failed'])
    expect(saved).toBe(true)
  })
})

describe('a result posted away from the thread its automation was made in', () => {
  it('starts with a line naming the automation and that thread', async () => {
    const posts: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const deps = {
      cloudSignedOut: () => false,
      turnForOf: async () => 'owner',
      postAsBot: (_bot: unknown, body: unknown) => {
        posts.push(body)
        return Promise.resolve({ ok: true, value: undefined })
      }
    } as unknown as BotRunDeliveryDependencies
    const bot = {
      botId: 'b1',
      runsIn: 'chat',
      resultsTo: { channel: 'C9' },
      originThread: { source: 'slack', externalId: 'T1:C1:1.2', place: '#design' }
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    await deliverBotRunResult(deps, {
      automation: { id: 'a1', name: 'Weekly recap', dtstart: 1, bot },
      run: { id: 'r1', trigger: 'scheduled' },
      bot: { id: 'b1', name: 'Ranger' },
      target: { runsIn: 'chat', resultsTo: bot.resultsTo },
      sessionId: 'run-chat',
      ended: { outcome: 'success', message: 'All green.' }
    } as unknown as BotRunResult)
    expect(posts).toEqual([
      {
        postId: 'r1',
        channelId: 'C9',
        turnFor: 'owner',
        text: '_From the automation “Weekly recap”, created in the Slack thread in #design._\n\nAll green.'
      }
    ])
  })
})

describe('a result posted into the thread its automation was made in', () => {
  it('starts with a line naming the automation', async () => {
    const replies: unknown[][] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const deps = {
      cloudSignedOut: () => false,
      turnForOf: async () => 'owner',
      replyInThread: (...args: unknown[]) => {
        replies.push(args)
        return Promise.resolve({ ok: true, value: {} })
      }
    } as unknown as BotRunDeliveryDependencies
    const conversation = { source: 'slack', externalId: 'T1:C1:1.2' } as const
    const bot = {
      botId: 'b1',
      runsIn: 'new',
      resultsTo: 'thread',
      originThread: { ...conversation, place: '#design', sessionId: 'thread-chat' }
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    await deliverBotRunResult(deps, {
      automation: { id: 'a1', name: 'Redo the review', dtstart: 1, bot },
      run: { id: 'r1', trigger: 'scheduled' },
      bot: { id: 'b1', name: 'Ranger' },
      target: { runsIn: 'new', resultsTo: 'thread', threadPost: conversation },
      sessionId: 'run-conv',
      ended: { outcome: 'success', message: 'Redone.' }
    } as unknown as BotRunResult)
    expect(replies).toEqual([
      [
        conversation,
        'run-result:r1',
        '_From the automation “Redo the review”, created in this thread._\n\nRedone.',
        'owner'
      ]
    ])
  })
})

describe('a result posted into its thread when the chat that answers it was gone', () => {
  it('still posts the copy named besides the thread', async () => {
    const replies: unknown[] = []
    const posts: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const deps = {
      cloudSignedOut: () => false,
      turnForOf: async () => 'owner',
      replyInThread: (...args: unknown[]) => {
        replies.push(args[2])
        return Promise.resolve({ ok: true, value: {} })
      },
      postAsBot: (_bot: unknown, body: unknown) => {
        posts.push(body)
        return Promise.resolve({ ok: true, value: undefined })
      }
    } as unknown as BotRunDeliveryDependencies
    const conversation = { source: 'slack', externalId: 'T1:C1:1.2' } as const
    const copyTo = { channel: 'C9', label: '#news' } as const
    const bot = {
      botId: 'b1',
      runsIn: 'chat',
      resultsTo: copyTo,
      originThread: { ...conversation, place: '#design', sessionId: 'thread-chat' }
    } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const completion = await deliverBotRunResult(deps, {
      automation: { id: 'a1', name: 'Redo the review', dtstart: 1, bot },
      run: { id: 'r1', trigger: 'scheduled' },
      bot: { id: 'b1', name: 'Ranger' },
      target: { runsIn: 'new', resultsTo: 'thread', threadPost: conversation, copyTo },
      sessionId: 'run-conv',
      ended: { outcome: 'success', message: 'Redone.' }
    } as unknown as BotRunResult)
    expect(completion.error).toBeUndefined()
    expect(replies).toEqual([
      '_From the automation “Redo the review”, created in this thread._\n\nRedone.'
    ])
    expect(posts).toEqual([
      expect.objectContaining({
        channelId: 'C9',
        text: '_From the automation “Redo the review”, created in the Slack thread in #design._\n\nRedone.'
      })
    ])
  })
})

describe('a thread post and its copy, each on its own', () => {
  const conversation = { source: 'slack', externalId: 'T1:C1:1.2' } as const
  const copyTo = { channel: 'C9', label: '#news' } as const
  const bot = {
    botId: 'b1',
    runsIn: 'chat',
    resultsTo: copyTo,
    originThread: { ...conversation, place: '#design', sessionId: 'thread-chat' }
  } as const
  async function deliver(options: { threadOk: boolean; signedOut?: boolean }) {
    const posts: unknown[] = []
    const notes: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const deps = {
      cloudSignedOut: () => options.signedOut === true,
      turnForOf: async () => 'owner',
      noteToRun: async (_session: string, _id: string, text: string) => {
        notes.push(text)
      },
      replyInThread: () =>
        Promise.resolve(options.threadOk ? { ok: true, value: {} } : { ok: false }),
      postAsBot: (_bot: unknown, body: unknown) => {
        posts.push(body)
        return Promise.resolve({ ok: true, value: undefined })
      }
    } as unknown as BotRunDeliveryDependencies
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
    const completion = await deliverBotRunResult(deps, {
      automation: { id: 'a1', name: 'Redo the review', dtstart: 1, bot },
      run: { id: 'r1', trigger: 'scheduled' },
      bot: { id: 'b1', name: 'Ranger' },
      target: { runsIn: 'new', resultsTo: 'thread', threadPost: conversation, copyTo },
      sessionId: 'run-conv',
      ended: { outcome: 'success', message: 'Redone.' }
    } as unknown as BotRunResult)
    return { completion, posts, notes }
  }

  it('still posts the copy when the thread refused its post, and says so', async () => {
    const { completion, posts } = await deliver({ threadOk: false })
    expect(posts).toHaveLength(1)
    expect(completion.error).toBe("The result couldn't be posted.")
  })

  it('says how to sign in when the host is signed out, for the thread and the copy', async () => {
    const { completion, posts, notes } = await deliver({ threadOk: true, signedOut: true })
    expect(posts).toEqual([])
    expect(notes).toHaveLength(2)
    expect(completion.error).toContain('Not posted to Slack')
    expect(completion.error).toContain("The copy wasn't posted: Not posted to Slack")
  })
})
