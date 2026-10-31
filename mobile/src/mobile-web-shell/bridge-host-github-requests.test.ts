import { afterEach, expect, it, vi } from 'vitest'
import { BridgeHostRequests } from './bridge-host-requests'
import { bridgeId, createFakeRpcClient, rpcSuccess } from './bridge-host-test-fakes'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge/bridge-caps'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as capability } from '../../../src/shared/source-control-runtime-capabilities'
import { classifyExactGitHubOperation } from '../../../src/shared/github/exact-work-item-operation'
import { createPageClient, INIT, GRANTS } from './bridge/bridge-page-client-test-harness'

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
  expect(f.client.requests.slice(2).map((request) => request.args)).toEqual([
    ['github.listLabels'],
    ['github.listLabels', params],
    ['github.listLabels', undefined, { envelope }]
  ])
  f.requests.closeAll(false)
})
it('rejects malformed opt-in rather than silently forwarding as legacy', () => {
  expect(() =>
    classifyExactGitHubOperation('github.updateIssue', { ...params, ownerRepo: null }, envelope)
  ).toThrow()
  const f = hostRequests()
  f.requests.open({ ...frame(), params: { ...params, ownerRepo: { owner: '', repo: 'widgets' } } })
  expect(f.client.requests).toEqual([])
  expect(f.error).toHaveBeenCalledOnce()
  expect(classifyExactGitHubOperation('github.listLabels', params, {})).toBeNull()
})
it('cancelled probes retain inFlight occupancy, release listeners immediately and cannot settle a reused id', async () => {
  const f = hostRequests()
  for (let i = 1; i <= BRIDGE_MAX_PENDING_REQUESTS; i++) {
    f.requests.open(frame(bridgeId(i)))
    f.requests.cancel(bridgeId(i))
  }
  expect(f.client.stateListeners()).toBe(0)
  f.requests.open(frame(bridgeId(1)))
  expect(f.error).toHaveBeenCalledWith(
    bridgeId(1),
    expect.objectContaining({ message: expect.stringContaining('over') })
  )
  const probes = [...f.client.requests]
  for (const request of probes) {
    request.resolve(rpcSuccess('probe', status))
  }
  await flush()
  expect(f.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
  expect(f.reply).not.toHaveBeenCalled()
  f.requests.open(frame())
  f.requests.open(frame()) // collision must not retire the original
  expect(f.client.stateListeners()).toBe(1)
  f.client.requests.at(-1)!.resolve(rpcSuccess('new-probe', status))
  await flush()
  expect(f.client.requests.at(-1)?.method).toBe('github.listLabels')
  f.client.requests.at(-1)!.resolve(rpcSuccess('new-list', []))
  await flush()
  expect(f.reply).toHaveBeenCalledOnce()
  expect(f.client.stateListeners()).toBe(0)
})
it('does not reset an explicitly spanning deadline during preparation', async () => {
  vi.useFakeTimers()
  const f = hostRequests()
  f.requests.open({ ...frame(), options: { timeoutMs: 100, budgetSpansConnect: true } })
  await vi.advanceTimersByTimeAsync(101)
  f.client.requests[0].resolve(rpcSuccess('probe', status))
  await flush()
  expect(f.client.requests).toHaveLength(1)
  expect(f.error).toHaveBeenCalledWith(
    bridgeId(1),
    expect.objectContaining({ message: expect.stringContaining('Timed out') })
  )
  expect(f.client.stateListeners()).toBe(0)
})
it('keeps a page callback local, preserves callback-only arity, and allocates no pending id when it throws', async () => {
  const page = createPageClient()
  page.deliver({ ...INIT, grants: { ...GRANTS, native: ['rpcEnvelope'] } })
  const beforeSend = vi.fn(() => {
    throw new Error('retired')
  })
  await expect(
    page.client.sendRequest('github.listLabels', undefined, { beforeSend })
  ).rejects.toThrow('retired')
  expect(page.frames().filter((message) => message.type === 'request')).toHaveLength(0)
  const pending = page.client.sendRequest('status.get', undefined, { beforeSend: () => {} })
  const request = page.frames().find((message) => message.type === 'request')
  expect(request).not.toHaveProperty('options')
  if (!request || !('id' in request)) {
    throw new Error('missing request')
  }
  page.deliver({ v: 1, type: 'reply', id: request.id, payload: rpcSuccess('status', {}) })
  await pending
  page.client.close()
})
