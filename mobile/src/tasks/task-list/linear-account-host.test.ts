import { expect, it } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { bindLinearAccountClient, linearAccountClient } from './linear-account-host'
import { linearAccountConnect } from './mobile-task-list-operations'

/** A paired desktop whose "New projects open on" host the test can change. */
function desktop(trackerAccountHost: string | undefined) {
  const state = { trackerAccountHost }
  const sent: { method: string; executionHost: unknown }[] = []
  const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> = {
    getState: () => 'connected',
    getGeneration: () => 1,
    onStateChange: () => () => {},
    sendRequest: async (method, _params, options): Promise<RpcResponse> => {
      sent.push({ method, executionHost: options?.envelope?.executionHost })
      if (method === 'settings.get') {
        return { id: '1', ok: true, result: { settings: { ...state } } }
      }
      return { id: '2', ok: true, result: { ok: true } }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bound client uses only these members here.
  return { client: partial as RpcClient, state, sent }
}

it('keeps the Linear key on the host bound when setup opened after the default changes', async () => {
  const host = desktop('runtime:server-a')
  const binding = {
    base: host.client,
    client: bindLinearAccountClient(host.client, [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY])
  }
  await binding.client
  host.state.trackerAccountHost = 'local'

  await linearAccountConnect.request(await linearAccountClient(binding, host.client), {
    apiKey: 'lin_api_x'
  })

  expect(host.sent.at(-1)).toEqual({ method: 'linear.connect', executionHost: 'runtime:server-a' })
})

it('tags this computer explicitly so a later default cannot move the key', async () => {
  const host = desktop('local')
  const bound = await bindLinearAccountClient(host.client, [])

  await linearAccountConnect.request(bound, { apiKey: 'lin_api_x' })

  expect(host.sent.at(-1)).toEqual({ method: 'linear.connect', executionHost: 'local' })
})

it('leaves routing to an older desktop that names no host', async () => {
  const host = desktop(undefined)
  const bound = await bindLinearAccountClient(host.client, [])

  await linearAccountConnect.request(bound, { apiKey: 'lin_api_x' })

  expect(host.sent.at(-1)).toEqual({ method: 'linear.connect', executionHost: undefined })
})
