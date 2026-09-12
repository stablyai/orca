import { expect, it, vi } from 'vitest'
import { SshSessionNetworkTunnels } from './ssh-session-network-tunnels'
import { SshNetworkTunnelNotAdmittedError } from './ssh-relay-network-tunnel-transport'
import type { captureSshNetworkTunnelBinding } from './ssh-relay-network-tunnel-binding'

const resetRequest = {
  version: 1 as const,
  operationId: 'reset-operation',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'lease'
}

function fixture() {
  const cohort = new SshSessionNetworkTunnels()
  const binding = {
    mux: {},
    owner: {},
    assertCurrent: vi.fn(),
    assertAdmission: vi.fn()
  } as unknown as ReturnType<typeof captureSshNetworkTunnelBinding>
  const drain = { drain: vi.fn(async (_signal: AbortSignal) => {}), assertDrained: vi.fn() }
  const tunnel = {
    fenceForDrain: vi.fn(() => drain),
    closeAfterDrain: vi.fn(async () => {}),
    fail: vi.fn(),
    open: vi.fn()
  }
  const pending = Promise.withResolvers<typeof tunnel>()
  const create = vi.fn(() => pending.promise)
  return { cohort, binding, drain, tunnel, pending, create }
}

it('fences a tunnel whose admitted startup completes after reset begins', async () => {
  const f = fixture()
  const opening = f.cohort.open(f.binding, {}, f.create)
  const fence = f.cohort.fenceForDrain()
  const done = vi.fn()
  const draining = fence.drain(new AbortController().signal).then(done)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  await expect(f.cohort.open(f.binding, {}, f.create)).rejects.toThrow('admission_closed')
  f.pending.resolve(f.tunnel)
  await opening
  await draining
  expect(f.tunnel.fenceForDrain).toHaveBeenCalledOnce()
  expect(f.drain.drain).toHaveBeenCalledOnce()
  expect(f.tunnel.fail).not.toHaveBeenCalled()
})

it('retains failed startup and does not claim successful reset', async () => {
  const f = fixture()
  const opening = f.cohort.open(f.binding, {}, f.create)
  f.pending.reject(new Error('startup uncertain'))
  await expect(opening).rejects.toThrow('startup uncertain')
  const fence = f.cohort.fenceForDrain()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('startup uncertain')
})

it('retains startup accounting when a drain observer aborts', async () => {
  const f = fixture()
  const opening = f.cohort.open(f.binding, {}, f.create)
  const fence = f.cohort.fenceForDrain()
  const controller = new AbortController()
  const waiting = fence.drain(controller.signal)
  controller.abort()
  await expect(waiting).rejects.toThrow()
  expect(f.tunnel.fail).not.toHaveBeenCalled()
  f.pending.resolve(f.tunnel)
  await opening
  await fence.drain(new AbortController().signal)
})

it('retains host tunnel until reset owns retirement instead of sending close during reset', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  const tunnel = await f.cohort.open(f.binding, {}, f.create)
  f.cohort.fenceForDrain()
  await f.cohort.release(tunnel, new AbortController().signal)
  expect(f.tunnel.closeAfterDrain).not.toHaveBeenCalled()
  expect(f.drain.drain).toHaveBeenCalledOnce()
})

it('releases normally only after host-confirmed close', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  const tunnel = await f.cohort.open(f.binding, {}, f.create)
  await f.cohort.release(tunnel, new AbortController().signal)
  await f.cohort.fenceForDrain().drain(new AbortController().signal)
  expect(f.tunnel.closeAfterDrain).toHaveBeenCalledOnce()
  expect(f.tunnel.fenceForDrain).not.toHaveBeenCalled()
})

it('joins an in-flight graceful close before reset without draining its retired client', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  const tunnel = await f.cohort.open(f.binding, {}, f.create)
  const closed = Promise.withResolvers<void>()
  f.tunnel.closeAfterDrain.mockReturnValue(closed.promise)
  const release = f.cohort.release(tunnel, new AbortController().signal)
  const duplicate = f.cohort.release(tunnel, new AbortController().signal)
  const fence = f.cohort.fenceForDrain()
  const done = vi.fn()
  const drain = fence.drain(new AbortController().signal).then(done)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  expect(f.tunnel.fenceForDrain).not.toHaveBeenCalled()
  closed.resolve()
  await Promise.all([release, duplicate, drain])
  expect(f.tunnel.closeAfterDrain).toHaveBeenCalledOnce()
  expect(fence.assertDrained).not.toThrow()
})

it('retains uncertain close across a concurrent reset and observation retry', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  const tunnel = await f.cohort.open(f.binding, {}, f.create)
  const closed = Promise.withResolvers<void>()
  f.tunnel.closeAfterDrain.mockReturnValue(closed.promise)
  const release = f.cohort.release(tunnel, new AbortController().signal)
  const fence = f.cohort.fenceForDrain()
  const drain = fence.drain(new AbortController().signal)
  closed.reject(new Error('close receipt lost'))
  await expect(release).rejects.toThrow('close receipt lost')
  await expect(drain).rejects.toThrow('close receipt lost')
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('close receipt lost')
})

it('fences every tunnel despite an earlier failed tunnel and retains the failure', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  await f.cohort.open(f.binding, {}, f.create)
  const second = { ...f.tunnel, fenceForDrain: vi.fn(() => f.drain) }
  await f.cohort.open(f.binding, {}, async () => second)
  f.tunnel.fenceForDrain.mockImplementation(() => {
    throw new Error('old tunnel failed')
  })
  const fence = f.cohort.fenceForDrain()
  expect(second.fenceForDrain).toHaveBeenCalledOnce()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('old tunnel failed')
})

it('does not admit more tunnels into a cohort with unresolved failure', async () => {
  const f = fixture()
  f.pending.reject(new Error('uncertain remote open'))
  await expect(f.cohort.open(f.binding, {}, f.create)).rejects.toThrow()
  await expect(f.cohort.open(f.binding, {}, f.create)).rejects.toThrow('uncertain remote open')
  expect(f.create).toHaveBeenCalledOnce()
})

it('does not poison reset when negotiation proves no remote tunnel was requested', async () => {
  const f = fixture()
  const refused = async () => {
    throw new SshNetworkTunnelNotAdmittedError(new Error('old host'))
  }
  await expect(f.cohort.open(f.binding, {}, refused)).rejects.toThrow('old host')
  f.pending.resolve(f.tunnel)
  await f.cohort.open(f.binding, {}, f.create)
  await f.cohort.fenceForDrain().drain(new AbortController().signal)
})

it('checks every selected tunnel before preserving any reset proof', async () => {
  const f = fixture()
  const first = {
    ...f.tunnel,
    assertResetRetirementReady: vi.fn(),
    confirmResetRetirement: vi.fn()
  }
  const second = {
    ...first,
    assertResetRetirementReady: vi.fn((): void => {
      throw new Error('second owner changed')
    }),
    confirmResetRetirement: vi.fn()
  }
  await f.cohort.open(f.binding, {}, async () => first)
  await f.cohort.open(f.binding, {}, async () => second)
  const fence = f.cohort.fenceForDrain()
  await fence.drain(new AbortController().signal)
  expect(() => fence.confirmResetRetirement(resetRequest)).toThrow('second owner changed')
  expect(first.confirmResetRetirement).not.toHaveBeenCalled()
  expect(second.confirmResetRetirement).not.toHaveBeenCalled()
  second.assertResetRetirementReady.mockImplementation(() => {})
  fence.confirmResetRetirement(resetRequest)
  expect(first.confirmResetRetirement).toHaveBeenCalledWith(resetRequest)
  expect(second.confirmResetRetirement).toHaveBeenCalledWith(resetRequest)
})

it('refuses reset proof when a retained tunnel has no reset confirmation contract', async () => {
  const f = fixture()
  f.pending.resolve(f.tunnel)
  await f.cohort.open(f.binding, {}, f.create)
  const fence = f.cohort.fenceForDrain()
  await fence.drain(new AbortController().signal)
  expect(() => fence.confirmResetRetirement(resetRequest)).toThrow('reset_proof_unavailable')
})

it('refuses reset proof while admitted startup is still pending', async () => {
  const f = fixture()
  const opening = f.cohort.open(f.binding, {}, f.create)
  const fence = f.cohort.fenceForDrain()
  expect(() => fence.confirmResetRetirement(resetRequest)).toThrow()
  f.pending.resolve(f.tunnel)
  await opening
})
