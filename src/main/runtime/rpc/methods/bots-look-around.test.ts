import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { applyBotUpdates } from '../../../../shared/rpc-contract/bots-params'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotLookAroundStore } from '../../../bots/bot-look-around-store'
import { beginRun } from '../../../bots/bot-look-around-state'
import { LOOK_AROUND_REFUSAL, REPLY_ONLY_REFUSAL } from '../../../bots/bot-look-around-policy'
import { assertLookAroundMayCall } from '../look-around-rpc-guard'
import { AUTOMATION_METHODS } from './automations/automations'
import { BOT_LOOK_AROUND_METHODS } from './bots-look-around'
import { botRunTokens } from '../../../bots/tool-relay/bot-run-tokens.test-fixture'

const chatLines = vi.hoisted((): unknown[] => [])
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => { id: string }[] }, sessionId: string) =>
    sessionId === 'bot-chat' ? bots.list()[0] : null
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (_destination: unknown, entry: unknown) => {
      chatLines.push(entry)
    }
  })
}))

const lookNow = vi.hoisted((): { outcome: unknown } => ({ outcome: { started: true } }))
vi.mock('../../../bots/bot-look-around-runtime', () => ({
  runtimeLookAroundRunner: () => ({ lookNow: () => lookNow.outcome })
}))

const tokens = botRunTokens(['b1'])

/** A call naming its session comes from b1's chat or look, which hold b1's token. */
const request = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params,
  ...(typeof params === 'object' && params !== null && 'callerSessionId' in params
    ? { botToken: tokens.b1 }
    : {})
})

type BotUpdates = Parameters<typeof applyBotUpdates>[1]

function lookRuntime() {
  let bot: Bot = makeTestBot({ id: 'b1', agent: 'claude' })
  const lookAround = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  lookAround.update('b1', (state) => ({ state: beginRun(state, 'look-1', 0), result: null }))
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: {
      enabled: () => true,
      assertEnabled: () => {},
      list: () => [bot],
      update: vi.fn(
        async (_id: string, edit: BotUpdates | ((saved: Bot) => BotUpdates)): Promise<Bot> => {
          bot = applyBotUpdates(bot, typeof edit === 'function' ? edit(bot) : edit)
          return bot
        }
      )
    },
    lookAround,
    createAutomation: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots, runtime.lookAround, createAutomation and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime: service,
    methods: [...BOT_LOOK_AROUND_METHODS, ...AUTOMATION_METHODS]
  })
  return { runtime, dispatcher, bot: () => bot }
}

const idea = { title: 'Review #12', why: 'Asked for you', ask: 'Review PR #12' }

describe('Look around over RPC', () => {
  it('takes suggestions only from a look, and Start hands back the ask once', async () => {
    const { dispatcher, runtime } = lookRuntime()

    expect(
      await dispatcher.dispatch(request('bots.suggest', { ...idea, callerSessionId: 'bot-chat' }))
    ).toMatchObject({ ok: false })
    const made = await dispatcher.dispatch(
      request('bots.suggest', { ...idea, callerSessionId: 'look-1' })
    )
    expect(made).toMatchObject({ ok: true, result: { suggestion: { title: 'Review #12' } } })
    // A paired client's session id names no chat on this host.
    expect(
      await dispatcher.dispatch(request('bots.suggest', { ...idea, callerSessionId: 'look-1' }), {
        pairedDeviceId: 'phone-7'
      })
    ).toMatchObject({ ok: false })

    const id = runtime.lookAround.get('b1').suggestions[0].id
    const act = { botId: 'b1', suggestionId: id }
    expect(await dispatcher.dispatch(request('bots.suggestions.start', act))).toMatchObject({
      ok: true,
      result: { ask: 'Review PR #12' }
    })
    expect(await dispatcher.dispatch(request('bots.suggestions.start', act))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('already_started') }
    })
    expect(await dispatcher.dispatch(request('bots.suggestions.dismiss', act))).toMatchObject({
      ok: false
    })
  })

  it("counts new suggestions until the owner sees the bot's Up next", async () => {
    const { dispatcher } = lookRuntime()
    await dispatcher.dispatch(request('bots.suggest', { ...idea, callerSessionId: 'look-1' }))

    expect(await dispatcher.dispatch(request('bots.upNext.unseen'))).toMatchObject({
      ok: true,
      result: { unseen: { b1: 1 } }
    })
    expect(await dispatcher.dispatch(request('bots.upNext.seen', { botId: 'b1' }))).toMatchObject({
      ok: true
    })
    expect(await dispatcher.dispatch(request('bots.upNext.unseen'))).toMatchObject({
      ok: true,
      result: { unseen: {} }
    })
    expect(
      await dispatcher.dispatch(request('bots.upNext.seen', { botId: 'missing' }))
    ).toMatchObject({ ok: false })
  })

  it('dismisses a suggestion so the bot cannot make it again', async () => {
    const { dispatcher, runtime } = lookRuntime()
    await dispatcher.dispatch(request('bots.suggest', { ...idea, callerSessionId: 'look-1' }))
    const id = runtime.lookAround.get('b1').suggestions[0].id

    expect(
      await dispatcher.dispatch(
        request('bots.suggestions.dismiss', { botId: 'b1', suggestionId: id })
      )
    ).toMatchObject({ ok: true, result: { dismissed: true } })
    runtime.lookAround.update('b1', (state) => ({
      state: beginRun(state, 'look-2', 0),
      result: null
    }))
    expect(
      await dispatcher.dispatch(
        request('bots.suggest', { ...idea, title: 'review  #12', callerSessionId: 'look-2' })
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('dismissed') } })
  })

  it("changes the bot's own Look around from its chat and says so there", async () => {
    const { dispatcher, bot } = lookRuntime()
    chatLines.length = 0

    expect(
      await dispatcher.dispatch(
        request('bots.lookAround.set', { callerSessionId: 'bot-chat', focus: 'CI on main' })
      )
    ).toMatchObject({ ok: true, result: { change: 'Look around updated: looks for: CI on main' } })
    expect(bot().lookAround).toEqual({
      on: true,
      every: 'every-4h',
      weekdaysOnly: true,
      focus: 'CI on main'
    })
    await vi.waitFor(() =>
      expect(chatLines).toEqual([
        expect.objectContaining({
          body: { kind: 'status', text: 'Look around updated: looks for: CI on main' }
        })
      ])
    )
    expect(
      await dispatcher.dispatch(request('bots.lookAround.set', { botId: 'b1', on: false }))
    ).toMatchObject({ ok: true, result: { change: 'Look around turned off' } })
  })

  it('changes only what the chat names, over an edit the list has not caught up with', async () => {
    const { runtime, dispatcher, bot } = lookRuntime()
    const stale = bot()
    await runtime.bots.update('b1', { lookAround: { weekdaysOnly: false } })
    runtime.bots.list = () => [stale]

    expect(
      await dispatcher.dispatch(request('bots.lookAround.set', { botId: 'b1', focus: 'CI' }))
    ).toMatchObject({ ok: true, result: { change: 'Look around updated: looks for: CI' } })
    expect(bot().lookAround).toEqual({
      on: true,
      every: 'every-4h',
      weekdaysOnly: false,
      focus: 'CI'
    })
  })

  it('refuses a look changing its own Look around or making an automation', async () => {
    const { dispatcher, runtime } = lookRuntime()

    expect(
      await dispatcher.dispatch(
        request('bots.lookAround.set', { callerSessionId: 'look-1', on: false })
      )
    ).toMatchObject({ ok: false })
    expect(
      await dispatcher.dispatch(
        request('automation.create', {
          callerSessionId: 'look-1',
          name: 'x',
          prompt: 'y',
          agentId: 'claude',
          runContext: {
            kind: 'workspace-run',
            projectId: 'p',
            hostId: 'local',
            projectHostSetupId: 's',
            repoId: 'r',
            path: '/srv/p'
          },
          rrule: '0 9 * * *',
          dtstart: 1
        })
      )
    ).toMatchObject({ ok: false, error: { message: LOOK_AROUND_REFUSAL } })
    expect(runtime.createAutomation).not.toHaveBeenCalled()
  })
})

describe('Look now', () => {
  it('starts a look, and names why it would not', async () => {
    const { dispatcher } = lookRuntime()
    lookNow.outcome = { started: true }
    expect(
      await dispatcher.dispatch(request('bots.lookAround.lookNow', { botId: 'b1' }))
    ).toMatchObject({
      ok: true,
      result: { started: true }
    })
    lookNow.outcome = { refused: 'running' }
    expect(
      await dispatcher.dispatch(request('bots.lookAround.lookNow', { botId: 'b1' }))
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('look_now_running') }
    })
  })
})

describe('orchestration from a look', () => {
  const runtime = {
    lookAround: {
      botOfLook: (id: string) => (id === 'look-1' ? 'b1' : null),
      botOfTidyUp: (id: string) => (id === 'tidy-1' ? 'b1' : null)
    }
  }
  const call = (method: string, agentSessionId: string) => ({
    method,
    orchestrationCompatibilityEvidence: { agentSessionId }
  })

  it('may list workers but not start one', () => {
    expect(() =>
      assertLookAroundMayCall(runtime, call('orchestration.workerList', 'look-1'), undefined)
    ).not.toThrow()
    expect(() =>
      assertLookAroundMayCall(runtime, call('orchestration.workerStart', 'look-1'), undefined)
    ).toThrow(LOOK_AROUND_REFUSAL)
    expect(() =>
      assertLookAroundMayCall(runtime, call('orchestration.workerStart', 'bot-chat'), undefined)
    ).not.toThrow()
  })
})

describe('any call from a tidy-up', () => {
  it('is refused, by its session or as the caller named in its params', () => {
    const runtime = {
      lookAround: {
        botOfLook: () => null,
        botOfTidyUp: (id: string) => (id === 'tidy-1' ? 'b1' : null)
      }
    }
    expect(() =>
      assertLookAroundMayCall(
        runtime,
        {
          method: 'orchestration.workerList',
          orchestrationCompatibilityEvidence: { agentSessionId: 'tidy-1' }
        },
        undefined
      )
    ).toThrow(REPLY_ONLY_REFUSAL)
    expect(() =>
      assertLookAroundMayCall(runtime, { method: 'bots.memory.edit' }, undefined, {
        callerSessionId: 'tidy-1'
      })
    ).toThrow(REPLY_ONLY_REFUSAL)
    expect(() =>
      assertLookAroundMayCall(runtime, { method: 'bots.memory.edit' }, undefined, {
        callerSessionId: 'chat-1'
      })
    ).not.toThrow()
  })
})
