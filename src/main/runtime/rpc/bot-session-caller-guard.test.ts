import { describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../bots/bot.test-fixture'
import { BOT_TOKEN_ENDED } from '../../bots/bot-of-caller'
import type { OrchestrationSessionCaller } from '../orchestration/addressing/orchestration-caller-identity'
import {
  assertBotSessionCallerHoldsToken,
  BOT_SESSION_NEEDS_TOKEN
} from './bot-session-caller-guard'
import type { RpcContext, RpcRequest } from './core'

vi.mock('../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => { id: string }[] }, sessionId: string) =>
    bots.list().find((bot) => sessionId === `chat-${bot.id}`) ?? null
}))

const runtime = {
  bots: { enabled: () => true, list: () => [makeTestBot({ id: 'a' }), makeTestBot({ id: 'b' })] },
  lookAround: { botOfLook: (sessionId: string) => (sessionId === 'look-a' ? 'a' : null) }
}
const relay = { botOf: (token: string) => ({ 'tok-a': 'a', 'tok-b': 'b' })[token] ?? null }
const cli: Pick<RpcContext, 'caller' | 'pairedDeviceId'> = { caller: { kind: 'local-cli' } }

function check(
  call: {
    botToken?: string
    evidence?: string
    caller?: string
    params?: unknown
    context?: Pick<RpcContext, 'caller' | 'pairedDeviceId'>
  } = {}
): void {
  const request: Pick<RpcRequest, 'botToken' | 'orchestrationCompatibilityEvidence'> = {
    botToken: call.botToken,
    ...(call.evidence
      ? { orchestrationCompatibilityEvidence: { agentSessionId: call.evidence } }
      : {})
  }
  const sessionCaller = call.caller
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only kind and sessionId.
      ({ sessionId: call.caller } as unknown as OrchestrationSessionCaller)
    : undefined
  assertBotSessionCallerHoldsToken(
    runtime,
    request,
    call.context ?? cli,
    sessionCaller,
    call.params,
    relay
  )
}

describe('a CLI call naming a bot chat as its caller', () => {
  it("is refused without that bot's token, or with another bot's", () => {
    expect(() => check({ params: { callerSessionId: 'chat-a' } })).toThrow(BOT_SESSION_NEEDS_TOKEN)
    expect(() => check({ params: { callerSessionId: 'chat-a' }, botToken: 'tok-b' })).toThrow(
      BOT_SESSION_NEEDS_TOKEN
    )
  })

  it("is admitted with the bot's own token, from its chat or its look-around run", () => {
    expect(() => check({ params: { callerSessionId: 'chat-a' }, botToken: 'tok-a' })).not.toThrow()
    expect(() => check({ evidence: 'look-a', botToken: 'tok-a' })).not.toThrow()
  })

  it('is checked wherever the call names its session', () => {
    expect(() => check({ evidence: 'chat-b', botToken: 'tok-a' })).toThrow(BOT_SESSION_NEEDS_TOKEN)
    expect(() => check({ caller: 'chat-b', botToken: 'tok-a' })).toThrow(BOT_SESSION_NEEDS_TOKEN)
    expect(() => check({ params: { callerAgentSessionId: 'chat-b' }, botToken: 'tok-a' })).toThrow(
      BOT_SESSION_NEEDS_TOKEN
    )
    expect(() =>
      check({ params: { callerSessionId: 'chat-a' }, evidence: 'chat-b', botToken: 'tok-a' })
    ).toThrow(BOT_SESSION_NEEDS_TOKEN)
  })

  it('says the token ended when Orca restarted since the run began', () => {
    expect(() => check({ params: { callerSessionId: 'chat-a' }, botToken: 'stale' })).toThrow(
      BOT_TOKEN_ENDED
    )
  })

  it("leaves other sessions, people's windows and paired clients alone", () => {
    expect(() => check({ params: { callerSessionId: 'owner-chat' } })).not.toThrow()
    expect(() =>
      check({ params: { callerSessionId: 'chat-a' }, context: { caller: { kind: 'desktop' } } })
    ).not.toThrow()
    expect(() =>
      check({
        evidence: 'chat-a',
        context: {
          caller: { kind: 'paired-device', deviceId: 'd', agent: true },
          pairedDeviceId: 'd'
        }
      })
    ).not.toThrow()
  })
})
