import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordOrcadManagedStopDispatch } from './orcad-managed-stop-dispatch'
const { validate, validateStop, persist } = vi.hoisted(() => ({
  validate: vi.fn(),
  validateStop: vi.fn(),
  persist: vi.fn()
}))
vi.mock('./orcad-decommission-acceptance', () => ({
  validateOrcadDecommissionCancellation: validate,
  validateOrcadDecommissionTransaction: validateStop,
  persistOrcadDecommissionAcceptance: vi.fn()
}))
vi.mock('./orcad-canceled-stop-receipt', () => ({ persistOrcadCanceledStopReceipt: persist }))
import {
  configureOrcadDecommission,
  getOrcadManagedStopIdentity,
  requestOrcadManagedDecommission,
  requestOrcadManagedStopCancellation
} from './orcad-decommission'
import { OrcadManagedStopCancellationResultSchema } from '../../shared/orcad-managed-stop-cancellation'

const identity = { runtimeId: 'runtime', profileId: 'profile', profileRoot: '/host/profile' }
const instance = { pid: 123, startedAtMs: null, nonce: 'original', lockPath: '/host/orcad.lock' }
const request = {
  schemaVersion: 1 as const,
  version: '0.1.0+test',
  instance,
  authority: { ...identity, transactionId: '11111111-1111-4111-8111-111111111111' }
}
const cancel = () =>
  requestOrcadManagedStopCancellation(request, request.version, identity.runtimeId)
beforeEach(() => {
  instance.nonce = randomUUID()
  recordOrcadManagedStopDispatch(request.version, request.authority, request.instance)
})
afterEach(() => {
  configureOrcadDecommission(null)
  vi.resetAllMocks()
})

it('validates exact prepared ownership and native reopening before durable cancellation', () => {
  const native = vi.fn()
  const retire = vi.fn()
  configureOrcadDecommission(retire, identity, instance, native)
  expect(getOrcadManagedStopIdentity(identity.runtimeId, request.version).cancelPreparedStop).toBe(
    1
  )
  expect(OrcadManagedStopCancellationResultSchema.parse(cancel())).toEqual({
    ...request,
    outcome: 'canceled'
  })
  expect(validate).toHaveBeenCalledWith(request.authority, request.version, instance)
  expect(native).toHaveBeenCalledWith(request.authority)
  expect(persist).toHaveBeenCalledWith(expect.any(String), request)
  expect(validate.mock.invocationCallOrder[0]).toBeLessThan(native.mock.invocationCallOrder[0])
  expect(native.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0])
  expect(retire).not.toHaveBeenCalled()
})

it.each(['transaction', 'native', 'receipt'] as const)(
  'refuses %s uncertainty and permits a validated retry',
  (failure) => {
    const native = vi.fn()
    configureOrcadDecommission(vi.fn(), identity, instance, native)
    const failing = failure === 'transaction' ? validate : failure === 'native' ? native : persist
    failing.mockImplementationOnce(() => {
      throw new Error('unverifiable proof')
    })
    expect(cancel()).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    if (failure !== 'receipt') {
      expect(persist).not.toHaveBeenCalled()
    }
    expect(cancel()).toMatchObject({ outcome: 'canceled' })
  }
)

it('refuses missing native proof and replacement instances before reading or writing records', () => {
  configureOrcadDecommission(vi.fn(), identity, instance)
  expect(
    getOrcadManagedStopIdentity(identity.runtimeId, request.version).cancelPreparedStop
  ).toBeUndefined()
  expect(cancel()).toMatchObject({ outcome: 'refused' })
  configureOrcadDecommission(vi.fn(), identity, { ...instance, nonce: 'replacement' }, vi.fn())
  expect(cancel()).toMatchObject({ outcome: 'refused' })
  expect(validate).not.toHaveBeenCalled()
  expect(persist).not.toHaveBeenCalled()
})

it('shares whole-operation exclusion with stop and holds it through cancellation persistence', async () => {
  const native = vi.fn()
  const pending = Promise.withResolvers<{
    outcome: 'refused'
    verdict: 'live'
    code: string
    reason: string
  }>()
  configureOrcadDecommission(() => pending.promise, identity, instance, native)
  validateStop.mockReturnValue({ instance, transactionSnapshot: 'prepared' })
  const stop = () => requestOrcadManagedDecommission(request, request.version, identity.runtimeId)
  const active = stop()
  expect(cancel()).toMatchObject({ code: 'orcad_decommission_operation_pending' })
  expect(validate).not.toHaveBeenCalled()
  pending.resolve({ outcome: 'refused', verdict: 'live', code: 'live', reason: 'live terminal' })
  await active
  let reentered: ReturnType<typeof stop> | undefined
  persist.mockImplementationOnce(() => {
    reentered = stop()
    expect(cancel()).toMatchObject({ code: 'orcad_decommission_operation_pending' })
  })
  expect(cancel()).toMatchObject({ outcome: 'canceled' })
  expect(await reentered).toMatchObject({ code: 'orcad_decommission_operation_pending' })
})

it('refuses a configuration replacement during native proof validation', () => {
  configureOrcadDecommission(vi.fn(), identity, instance, () => configureOrcadDecommission(null))
  expect(cancel()).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
  expect(persist).not.toHaveBeenCalled()
})

it('cancels an exact unstarted transaction without asserting native reopening', () => {
  const original = { ...instance, nonce: randomUUID() }
  const unstarted = { ...request, instance: original }
  const native = vi.fn(() => {
    throw new Error('No native stop was attempted')
  })
  const retire = vi.fn()
  configureOrcadDecommission(retire, identity, original, native)
  expect(
    requestOrcadManagedStopCancellation(unstarted, request.version, identity.runtimeId)
  ).toEqual({ ...unstarted, outcome: 'canceled' })
  expect(validate).toHaveBeenCalledWith(request.authority, request.version, original)
  expect(persist).toHaveBeenCalledWith(expect.any(String), unstarted)
  expect(native).not.toHaveBeenCalled()
  expect(retire).not.toHaveBeenCalled()
})

it('retains actual dispatch uncertainty across adapter reconfiguration', async () => {
  const original = { ...instance, nonce: randomUUID() }
  const attempted = { ...request, instance: original }
  const native = vi.fn(() => {
    throw new Error('Native outcome uncertain')
  })
  configureOrcadDecommission(
    async () => {
      throw new Error('Lost native reply')
    },
    identity,
    original,
    native
  )
  validateStop.mockReturnValue({ instance: original, transactionSnapshot: 'prepared' })
  await expect(
    requestOrcadManagedDecommission(attempted, request.version, identity.runtimeId)
  ).rejects.toThrow('Lost native reply')
  configureOrcadDecommission(vi.fn(), identity, original, native)
  expect(
    requestOrcadManagedStopCancellation(attempted, request.version, identity.runtimeId)
  ).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
  expect(native).toHaveBeenCalledOnce()
  expect(persist).not.toHaveBeenCalled()
})
