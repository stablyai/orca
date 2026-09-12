import { expect, it, vi } from 'vitest'
import { SshNetworkTunnelGenerations } from './ssh-network-tunnel-generations'
import type { SshSessionNetworkTunnels } from './ssh-session-network-tunnels'
import type { captureSshNetworkTunnelBinding } from './ssh-relay-network-tunnel-binding'

function binding() {
  return {
    mux: {},
    connection: {},
    providerGeneration: 1,
    owner: {
      clientInstanceId: 'client',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'lease'
    },
    assertAdmission: vi.fn()
  } as unknown as ReturnType<typeof captureSshNetworkTunnelBinding>
}

function fixture() {
  const drains: { drain: ReturnType<typeof vi.fn>; assertDrained: ReturnType<typeof vi.fn> }[] = []
  const create = vi.fn(() => {
    const drain = { drain: vi.fn(async (_signal: AbortSignal) => {}), assertDrained: vi.fn() }
    drains.push(drain)
    return { fenceForDrain: vi.fn(() => drain) } as unknown as SshSessionNetworkTunnels
  })
  const generations = new SshNetworkTunnelGenerations(create)
  return { generations, create, drains }
}

it('reuses only an exact active generation', () => {
  const f = fixture()
  const original = binding()
  const first = f.generations.capture(original)
  expect(f.generations.capture({ ...original, owner: { ...original.owner } })).toBe(first)
  expect(f.create).toHaveBeenCalledOnce()
})

it.each([
  'mux',
  'connection',
  'providerGeneration',
  'clientInstanceId',
  'clientGeneration',
  'ownerGeneration',
  'ownerLease'
] as const)('rotates on changed %s and fences the former cohort', (field) => {
  const f = fixture()
  const original = binding()
  const first = f.generations.capture(original)
  const next = { ...original, owner: { ...original.owner } }
  switch (field) {
    case 'mux':
      next.mux = binding().mux
      break
    case 'connection':
      next.connection = binding().connection
      break
    case 'providerGeneration':
      next.providerGeneration++
      break
    case 'clientInstanceId':
      next.owner.clientInstanceId += 'next'
      break
    case 'clientGeneration':
      next.owner.clientGeneration++
      break
    case 'ownerGeneration':
      next.owner.ownerGeneration++
      break
    case 'ownerLease':
      next.owner.ownerLease += 'next'
      break
  }
  expect(f.generations.capture(next)).not.toBe(first)
  expect(first.fenceForDrain).toHaveBeenCalledOnce()
})

it('admits new generation but never clears failed old-generation evidence', async () => {
  const f = fixture()
  f.generations.capture(binding())
  f.drains[0].drain.mockRejectedValue(new Error('old output unverifiable'))
  expect(() => f.generations.capture(binding())).not.toThrow()
  await Promise.resolve()
  const fence = f.generations.fenceForDrain()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('old output unverifiable')
  expect(f.drains[1].drain).toHaveBeenCalledOnce()
  expect(() => f.generations.capture(binding())).toThrow('generations_fenced')
})

it('waits for pending retired generations despite an empty current one', async () => {
  const f = fixture()
  f.generations.capture(binding())
  const pending = Promise.withResolvers<void>()
  f.drains[0].drain.mockReturnValue(pending.promise)
  f.generations.capture(binding())
  const fence = f.generations.fenceForDrain()
  const done = vi.fn()
  const wait = fence.drain(new AbortController().signal).then(done)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  pending.resolve()
  await wait
  expect(f.drains[0].assertDrained).toHaveBeenCalledOnce()
})

it('bounds retained pending generations without evicting their evidence', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  for (let index = 0; index < 17; index++) {
    f.generations.capture(binding())
    f.drains[index].drain.mockReturnValue(pending.promise)
  }
  expect(() => f.generations.capture(binding())).toThrow('retirement_capacity')
  pending.resolve()
  await f.generations.fenceForDrain().drain(new AbortController().signal)
})

it('retains real old startup failure after a replacement cohort admits work', async () => {
  const generations = new SshNetworkTunnelGenerations()
  const oldBinding = binding()
  const old = generations.capture(oldBinding)
  const pending = Promise.withResolvers<never>()
  const opening = old.open(oldBinding, {}, () => pending.promise)
  const nextBinding = binding()
  const next = generations.capture(nextBinding)
  const drain = { drain: vi.fn(async () => {}), assertDrained: vi.fn() }
  const tunnel = {
    open: vi.fn(),
    fail: vi.fn(),
    closeAfterDrain: vi.fn(async () => {}),
    fenceForDrain: vi.fn(() => drain)
  }
  await next.open(nextBinding, {}, async () => tunnel)
  pending.reject(new Error('old open outcome unknown'))
  await expect(opening).rejects.toThrow('old open outcome unknown')
  const fence = generations.fenceForDrain()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow(
    'old open outcome unknown'
  )
  expect(() =>
    fence.confirmResetRetirement({
      version: 1,
      operationId: 'operation',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    })
  ).toThrow('old open outcome unknown')
  expect(tunnel.fenceForDrain).toHaveBeenCalledOnce()
  expect(tunnel.fail).not.toHaveBeenCalled()
})

it('joins an old real cohort release that completes after generation replacement', async () => {
  const generations = new SshNetworkTunnelGenerations()
  const oldBinding = binding()
  const old = generations.capture(oldBinding)
  const closed = Promise.withResolvers<void>()
  const tunnel = {
    open: vi.fn(),
    fail: vi.fn(),
    closeAfterDrain: vi.fn(() => closed.promise),
    fenceForDrain: vi.fn(() => ({ drain: vi.fn(async () => {}), assertDrained: vi.fn() }))
  }
  await old.open(oldBinding, {}, async () => tunnel)
  const release = old.release(tunnel, new AbortController().signal)
  generations.capture(binding())
  const fence = generations.fenceForDrain()
  const finished = vi.fn()
  const draining = fence.drain(new AbortController().signal).then(finished)
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  closed.resolve()
  await Promise.all([release, draining])
  expect(tunnel.fenceForDrain).not.toHaveBeenCalled()
})
