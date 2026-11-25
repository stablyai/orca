import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE } from '../../../../shared/connector-cloud-features'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { BOT_METHODS } from './bots'
import { BOT_SLACK_CHANNEL_HELLO_METHODS } from './bots-slack-channel-hello'

// Which chat a session is (its bot), and whom the turn running in it acts for.
const sessions = vi.hoisted(() => new Map<string, { bot: string; turnFor: string }>())
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    bots.list().find((bot) => bot.id === sessions.get(sessionId)?.bot) ?? null
}))
vi.mock('../../../bots/bot-turn-for', () => ({
  botTurnFor: async (_runtime: unknown, sessionId: string) =>
    sessions.get(sessionId)?.turnFor ?? 'someone_else'
}))
vi.mock('../../../bots/bot-chat-status-line', () => ({ noteInChat: vi.fn() }))

const SCOUT = makeTestBot({ id: 'scout', name: 'Scout', chatSessionId: 'scout-chat' })
const REVIEWER = makeTestBot({ id: 'reviewer', name: 'Reviewer' })
sessions.set('scout-chat', { bot: 'scout', turnFor: 'owner' })
sessions.set('scout-slack', { bot: 'scout', turnFor: 'someone_else' })
sessions.set('reviewer-chat', { bot: 'reviewer', turnFor: 'owner' })

const [setIntro] = BOT_SLACK_CHANNEL_HELLO_METHODS

function runtimeFor(options: { features?: string[] | null; look?: string } = {}) {
  const saved = new Map<string, Bot>([
    [SCOUT.id, { ...SCOUT }],
    [REVIEWER.id, { ...REVIEWER }]
  ])
  const update = vi.fn(
    async (id: string, edit: Partial<Bot> | ((bot: Bot) => Partial<Bot>)): Promise<Bot> => {
      const current = saved.get(id)!
      const next = { ...current, ...(typeof edit === 'function' ? edit(current) : edit) }
      saved.set(id, next)
      return next
    }
  )
  const features =
    options.features === undefined
      ? [CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE]
      : options.features
  const runtime = {
    bots: {
      assertEnabled: () => {},
      enabled: () => true,
      list: () => [...saved.values()],
      update
    },
    lookAround: { botOfLook: (sessionId: string) => (sessionId === options.look ? 'scout' : null) },
    getConnectorCloud: () => ({ cloudFeatures: () => (features ? new Set(features) : null) }),
    getRuntimeId: () => 'runtime-a',
    registerSubscriptionCleanup: () => {}
  }
  return { runtime, update, saved }
}

function contextFor(options: Parameters<typeof runtimeFor>[0] & { pairedDeviceId?: string } = {}) {
  const made = runtimeFor(options)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, lookAround, getConnectorCloud and pairedDeviceId.
  const context = {
    runtime: made.runtime,
    caller: LOCAL_CLI_RPC_CALLER,
    pairedDeviceId: options.pairedDeviceId
  } as unknown as RpcContext
  return { ...made, context }
}

describe('bots.slackChannelHello.set', () => {
  it('turns off a bot’s own intro in a turn its owner asked for, or a named bot’s from a terminal', async () => {
    const fromChat = contextFor()
    await expect(
      setIntro!.handler({ callerSessionId: 'scout-chat', off: true }, fromChat.context)
    ).resolves.toMatchObject({ bot: { id: 'scout' }, slackChannelHello: false, cloud: 'yes' })
    expect(fromChat.saved.get('scout')?.slackChannelHello).toBe(false)
    expect(fromChat.saved.get('reviewer')?.slackChannelHello).toBeUndefined()

    const fromTerminal = contextFor()
    await setIntro!.handler({ botId: 'reviewer', off: true }, fromTerminal.context)
    expect(fromTerminal.saved.get('reviewer')?.slackChannelHello).toBe(false)
  })

  it('refuses, and changes nothing, for every caller that may not turn it off', async () => {
    const refused: [string, Parameters<typeof contextFor>[0], Record<string, unknown>][] = [
      ['another bot’s chat', {}, { callerSessionId: 'scout-chat', botId: 'reviewer', off: true }],
      ['a turn for someone else', {}, { callerSessionId: 'scout-slack', off: true }],
      ['a look-around run', { look: 'scout-chat' }, { callerSessionId: 'scout-chat', off: true }],
      // A paired client's session claim names no chat, so it must name the bot.
      ['a paired claim', { pairedDeviceId: 'phone' }, { callerSessionId: 'scout-chat', off: true }],
      ['a cloud that doesn’t honour it', { features: [] }, { botId: 'scout', off: true }],
      ['no connection to Orca Cloud', { features: null }, { botId: 'scout', off: true }]
    ]
    for (const [why, options, params] of refused) {
      const { context, update, saved } = contextFor(options)
      await expect(setIntro!.handler(params as never, context), why).rejects.toThrow()
      expect(update, why).not.toHaveBeenCalled()
      expect(saved.get('scout')?.slackChannelHello, why).toBeUndefined()
      expect(saved.get('reviewer')?.slackChannelHello, why).toBeUndefined()
    }
  })

  it('cannot express on: its params refuse anything but off', () => {
    for (const off of [false, 'true', 1]) {
      expect(setIntro!.params!.safeParse({ botId: 'scout', off }).success, String(off)).toBe(false)
    }
    expect(setIntro!.params!.safeParse({ botId: 'scout', on: true }).data).not.toHaveProperty('on')
  })

  it('only reports without off, telling an unsupported cloud from no connection', async () => {
    for (const [features, cloud] of [
      [[], 'no'],
      [null, 'not_connected']
    ] as const) {
      const { context, update } = contextFor({ features: features as string[] | null })
      await expect(setIntro!.handler({ botId: 'scout' }, context)).resolves.toMatchObject({
        slackChannelHello: true,
        cloud
      })
      expect(update).not.toHaveBeenCalled()
    }
  })
})

describe('bots.update slackChannelHello', () => {
  it('is the owner’s Orca only: a CLI’s update is refused whole, with nothing saved', async () => {
    const { runtime, update } = runtimeFor()
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots.update refuses before it reads anything else of the runtime.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: BOT_METHODS.filter((method) => method.name === 'bots.update')
    })
    for (const updates of [
      { slackChannelHello: true },
      { slackChannelHello: false },
      // Batched with an unrelated key, nothing of the update applies.
      { paused: true, slackChannelHello: true }
    ]) {
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        {
          id: 'update',
          authToken: 'token',
          method: 'bots.update',
          params: { botId: 'scout', updates }
        },
        (reply) => replies.push(reply),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
      expect(JSON.parse(replies[0]!).error.message).toBe(
        'Only the owner can change what posts to Slack'
      )
    }
    expect(update).not.toHaveBeenCalled()
  })
})
