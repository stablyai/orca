import { afterEach, expect, it, vi } from 'vitest'
import { BridgeHostRequests } from './bridge-host-requests'
import { bridgeId, createFakeRpcClient, rpcSuccess, shellLocalCall } from './bridge-host-test-fakes'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as capability } from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'

const params = { repo: 'id:clone', ownerRepo: { owner: 'fork', repo: 'widgets' } }
const envelope = {
  executionHost: 'runtime:server',
  expectedRuntimeSource: { sourceId: 'server', runtimeId: 's' }
}
const status = { runtimeId: 'desktop', capabilities: [capability] }
const frame = (id = bridgeId(1)) => ({
  v: 1 as const,
  type: 'request' as const,
  id,
  method: 'github.listLabels',
  params,
  envelope
})
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}
afterEach(() => vi.useRealTimers())
function hostRequests() {
  const client = createFakeRpcClient()
  const reply = vi.fn(),
    error = vi.fn()
  const requests = new BridgeHostRequests({
    client,
    isIdTaken: () => false,
    sendReply: reply,
    sendError: error,
    capExceeded: (message) => new Error(message),
    serveNative: async () => rpcSuccess('native', null),
    readClientIdentity: () => 'phone'
  })
  return { client, requests, reply, error }
}
it('uses one unscoped first-hop probe, leaves final S distinct from D, and preserves unrelated optional calls', async () => {
  const f = hostRequests()
  f.requests.open(frame())
  expect(f.client.requests[0].args).toMatchObject([
    'status.get',
    undefined,
    { beforeSend: expect.any(Function) }
  ])
  expect(f.client.requests[0].args[2]).not.toHaveProperty('envelope')
  f.client.requests[0].resolve(rpcSuccess('probe', status))
  await flush()
  expect(f.client.requests[1].args).toMatchObject(['github.listLabels', params, { envelope }])
  f.client.requests[1].resolve(rpcSuccess('list', ['one']))
  await flush()
  expect(f.reply).toHaveBeenCalledWith(bridgeId(1), expect.objectContaining({ result: ['one'] }))
  expect(f.client.stateListeners()).toBe(0)
  for (const [index, fields] of [{}, { params }, { envelope }].entries()) {
    f.requests.open({
      v: 1,
      type: 'request',
      id: bridgeId(index + 2),
      method: 'github.listLabels',
      ...fields
    })
  }
  // Unrelated calls keep their data; the shell adds only its local pre-send fence.
  expect(f.client.requests.slice(2).map(({ args }) => shellLocalCall(args))).toEqual([
    ['github.listLabels', undefined, {}, 'function'],
    ['github.listLabels', params, {}, 'function'],
    ['github.listLabels', undefined, { envelope }, 'function']
  ])
  f.requests.closeAll(false)
})
