import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { BotCreateParams } from '../../../../shared/rpc-contract/bots-params'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_CREATE_METHOD } from './bots-create'

describe('bots.create', () => {
  // The desktop's own runtime and a paired server both take New bot through this method.
  it('takes an empty name, leaving the runtime to name the bot', async () => {
    const made: BotCreateParams[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: {
        assertEnabled: () => {},
        create: async (params: BotCreateParams) => {
          made.push(params)
          return makeTestBot({ id: 'b1', name: 'New bot' })
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a taking-over create reads only runtime.bots and the runtime id, which the stub provides.
    const service = runtime as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime: service, methods: [BOT_CREATE_METHOD] })

    const reply = await dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'bots.create',
        params: { name: '  ', takingOver: true }
      },
      { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
    )

    expect(reply).toMatchObject({ ok: true, result: { bot: { name: 'New bot' } } })
    expect(made.map((params) => params.name)).toEqual([''])
  })

  it('makes a template offer once per card, from any device', async () => {
    const offers: unknown[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: {
        assertEnabled: () => {},
        list: () => [makeTestBot({ id: 'atlas', name: 'Atlas' })],
        createFromOffer: async (params: BotCreateParams) => {
          offers.push(params.fromOffer)
          return { bot: makeTestBot({ id: 'release', name: 'Release' }), existing: true }
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an offer create reads only runtime.bots and the runtime id, which the stub provides.
    const service = runtime as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime: service, methods: [BOT_CREATE_METHOD] })

    const reply = await dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'bots.create',
        params: {
          name: 'Release',
          fromOffer: { botId: 'atlas', offerId: 'o1' },
          fromTemplate: { id: 'not-in-this-catalog', skills: [] }
        }
      },
      { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
    )

    expect(reply).toMatchObject({ ok: true, result: { bot: { id: 'release' } } })
    expect(offers).toEqual([{ botId: 'atlas', offerId: 'o1' }])
  })
})
