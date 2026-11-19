import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/cli-agent-caller-capability'
import { BOT_SHARE_METHODS } from './bots-share'
import { BOT_SHARE_RECEIVE_METHODS } from './bots-share-receive'

const bot = makeTestBot({ id: 'bot-1' })

/** Records what reached the share service, so a refusal is proven to stop before it. */
function shareRuntime(bots = [bot]) {
  const reached: string[] = []
  const record = (name: string) => async () => {
    reached.push(name)
    return { status: 'ok', value: {} }
  }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { assertEnabled: () => {}, list: () => bots },
    botShares: () => ({
      prepare: async () => {
        reached.push('prepare')
        return { candidateId: 'c1' }
      },
      view: async () => {
        reached.push('view')
        return []
      },
      list: record('list'),
      publish: record('publish'),
      update: record('update'),
      review: record('review'),
      stop: record('stop')
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods read only runtime.bots, runtime.botShares and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return {
    dispatcher: new RpcDispatcher({
      runtime: service,
      methods: [...BOT_SHARE_METHODS, ...BOT_SHARE_RECEIVE_METHODS]
    }),
    reached
  }
}

const request = (method: string, params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

const CALLS: [string, Record<string, unknown>][] = [
  ['bots.share.prepare', { botId: 'bot-1' }],
  ['bots.share.publish', { botId: 'bot-1', candidateId: 'c1' }],
  [
    'bots.share.publish',
    { botId: 'bot-1', candidateId: 'c1', link: { shareId: 's1', expectedVersionId: 'v1' } }
  ],
  ['bots.share.view', { botId: 'bot-1', candidateId: 'c1', part: 'soul' }],
  ['bots.share.stop', { shareId: 's1' }],
  ['bots.share.status', {}],
  ['bots.share.review', { shareId: 's1' }]
]

describe('who may share a bot', () => {
  it('refuses every share call from a client with no proven identity before it reaches the service', async () => {
    const { dispatcher, reached } = shareRuntime()
    for (const [method, params] of CALLS) {
      const result = await dispatcher.dispatch(request(method, params), { clientKind: 'runtime' })
      expect(result, method).toMatchObject({
        ok: false,
        error: { message: 'Share a bot from Orca or its `orca` CLI.' }
      })
    }
    expect(reached).toEqual([])
  })

  it.each([
    ['in an Orca window', { caller: DESKTOP_RPC_CALLER }],
    ['on a paired device', { pairedDeviceId: 'device-1' }],
    ["from an agent's orca CLI", { caller: LOCAL_CLI_RPC_CALLER }],
    [
      "from an agent's orca CLI over a paired device's pairing",
      { pairedDeviceId: 'device-1', clientCapabilities: [CLI_AGENT_CALLER_CLIENT_CAPABILITY] }
    ]
  ])('lets a trusted caller share %s', async (_where, options) => {
    const { dispatcher, reached } = shareRuntime()
    for (const [method, params] of CALLS) {
      expect(await dispatcher.dispatch(request(method, params), options), method).toMatchObject({
        ok: true
      })
    }
    expect(reached).toEqual(['prepare', 'publish', 'update', 'view', 'stop', 'list', 'review'])
  })

  it("lets the owner stop a link whose bot isn't on this computer", async () => {
    const { dispatcher, reached } = shareRuntime([])
    const stop = request('bots.share.stop', { shareId: 's1' })
    expect(await dispatcher.dispatch(stop, { caller: DESKTOP_RPC_CALLER })).toMatchObject({
      ok: true
    })
    expect(reached).toEqual(['stop'])
  })
})
