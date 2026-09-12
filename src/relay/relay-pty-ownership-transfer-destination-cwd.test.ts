import { expect, it, vi } from 'vitest'
import {
  context,
  identity,
  preparation,
  request,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD as method } from '../shared/pty-ownership-transfer-destination-cwd'

function setup(enabled = true) {
  const inspect = vi.fn(
    async (_identity: unknown, _isAuthorized: () => boolean): Promise<string | null> =>
      '/srv/current'
  )
  const adapter = makeDelegatedRelay(
    { loadAll: () => [], save: () => {}, remove: () => {} },
    {
      enableDestinationDelegationClaims: enabled,
      resolveTerminalIncarnation: () => identity.incarnationId,
      inspectDestinationCwd: inspect
    }
  )
  adapter.prepare(preparation)
  const handlers = new Map<string, MethodHandler>()
  adapter.register({
    onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler)
  } as unknown as RelayDispatcher)
  const params = { ...request(), destinationClaim: { generation: 1, claimId: 'claim-1' } }
  const read = (ctx = context(), value = params) => handlers.get(method)!(value, ctx)
  return { adapter, inspect, handlers, params, read }
}

it('registers only behind the destination claim gate', () => {
  expect(setup(false).handlers.has(method)).toBe(false)
})

it('requires an admitted claim and exact connection before inspecting', async () => {
  const f = setup()
  await expect(f.read()).rejects.toThrow('inspection_unverifiable')
  f.adapter.claimDestination(request(), context())
  await expect(f.read(context(3))).rejects.toThrow('inspection_unverifiable')
  await expect(f.read(context(2, 2))).rejects.toThrow('inspection_unverifiable')
  await expect(f.read(context(), { ...f.params, credential: '0'.repeat(64) })).rejects.toThrow(
    'unauthorized'
  )
  expect(f.inspect).not.toHaveBeenCalled()
})

it.each(['/srv/current', null])('returns measured cwd %s without credentials', async (cwd) => {
  const f = setup()
  f.adapter.claimDestination(request(), context())
  f.inspect.mockResolvedValue(cwd)
  const result = await f.read()
  expect(result).toMatchObject({ ...identity, cwd, destinationClaim: f.params.destinationClaim })
  expect(result).not.toHaveProperty('credential')
})

it.each(['claim', 'disconnect', 'abort'])(
  'discards a result after %s during the probe',
  async (mode) => {
    const f = setup()
    let stale = false
    const ctx = { ...context(), isStale: () => stale }
    f.adapter.claimDestination(request(), ctx)
    f.inspect.mockImplementation(async (_identity, authorized) => {
      expect(authorized()).toBe(true)
    if (mode === 'claim') {
      f.adapter.claimDestination(request(2), context(3))
    }
    if (mode === 'disconnect') {
      stale = true
    }
    if (mode === 'abort') {
      f.adapter.abort(preparation)
    }
      expect(authorized()).toBe(false)
      return '/srv/stale'
    })
  await expect(f.read(ctx)).rejects.toThrow('inspection_unverifiable')
  }
)
