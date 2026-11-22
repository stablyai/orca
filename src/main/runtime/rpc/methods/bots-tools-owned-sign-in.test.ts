import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_TOOLS_OWNED_SIGN_IN_METHODS } from './bots-tools-owned-sign-in'

const attempts = vi.hoisted(() => ({
  start: vi.fn(async () => ({ flowId: 'flow-1', revision: 1, phase: 'starting' }))
}))
vi.mock('../../../bots/bot-home', () => ({ botHomeFolder: () => '/bots/reviewer' }))
vi.mock('../../../bots/tool-oauth/bot-tool-owned-sign-in', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ownedSignInKey: async () => 'notion'
}))
vi.mock('../../../bots/tool-oauth/bot-tool-sign-in-attempts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startBotToolSignInAttempt: attempts.start
}))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => unknown[] }, sessionId: string) =>
    sessionId === 'bot-chat' ? (bots.list()[0] ?? null) : null
}))

function dispatcher() {
  const bot = makeTestBot({ id: 'bot-1' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sign-in start reads only runtime.bots, runtime.lookAround and the runtime id, which the stub provides.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { enabled: () => true, assertEnabled: () => {}, list: () => [bot] },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: BOT_TOOLS_OWNED_SIGN_IN_METHODS })
}

const start = (params: Record<string, unknown>) => ({
  id: 'r1',
  authToken: 'tok',
  method: 'bots.tools.signIn.start',
  params: { botId: 'bot-1', name: 'notion', mode: 'paste', ...params }
})

describe('bots.tools.signIn.start', () => {
  it('lets an agent’s CLI start a sign-in for a bot', async () => {
    expect(await dispatcher().dispatch(start({}), { caller: LOCAL_CLI_RPC_CALLER })).toMatchObject({
      ok: true,
      result: { flowId: 'flow-1' }
    })
    expect(attempts.start).toHaveBeenCalledWith(expect.any(String), 'notion', 'paste')
  })

  it('still refuses the bot’s own chat', async () => {
    attempts.start.mockClear()
    expect(
      await dispatcher().dispatch(start({ callerSessionId: 'bot-chat' }), {
        caller: LOCAL_CLI_RPC_CALLER
      })
    ).toMatchObject({
      ok: false,
      error: { message: 'A bot can’t sign itself in to apps. Sign in from Orca.' }
    })
    expect(attempts.start).not.toHaveBeenCalled()
  })
})
