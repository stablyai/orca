import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const validate = vi.hoisted(() => vi.fn())
const persist = vi.hoisted(() => vi.fn())
vi.mock('./orcad-decommission-acceptance', () => ({
  validateOrcadDecommissionTransaction: validate,
  persistOrcadDecommissionAcceptance: persist
}))

import {
  configureOrcadDecommission,
  getOrcadManagedStopIdentity,
  requestOrcadDecommission,
  requestOrcadManagedDecommission
} from './orcad-decommission'

const identity = { runtimeId: 'runtime-a', profileId: 'profile-a', profileRoot: '/host/profile-a' }
const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
const authority = { ...identity, transactionId }
const version = '0.1.0+same'
const originalInstance = {
  pid: 123,
  startedAtMs: null,
  nonce: 'original',
  lockPath: '/host/orcad.lock'
}
beforeEach(() => {
  validate.mockReturnValue({ transactionSnapshot: 'exact-transaction', instance: originalInstance })
})
afterEach(() => {
  configureOrcadDecommission(null)
  vi.resetAllMocks()
})

describe('identity-bound host decommission', () => {
  it('holds exclusion through native retirement and synchronous receipt persistence', async () => {
    const retirement = Promise.withResolvers<{ outcome: 'accepted' }>()
    const adapter = vi.fn(() => retirement.promise)
    configureOrcadDecommission(adapter, identity, originalInstance)
    const request = () =>
      requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    const first = request()
    expect(await request()).toMatchObject({ code: 'orcad_decommission_operation_pending' })
    let duringPersistence: ReturnType<typeof request> | undefined
    persist.mockImplementationOnce(() => {
      duringPersistence = request()
    })
    retirement.resolve({ outcome: 'accepted' })
    expect(await first).toMatchObject({ outcome: 'accepted' })
    expect(await duringPersistence).toMatchObject({ code: 'orcad_decommission_operation_pending' })
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(await request()).toMatchObject({ outcome: 'accepted' })
    expect(adapter).toHaveBeenCalledTimes(2)
  })

  it('releases exclusion after native failure without fabricating a receipt', async () => {
    const adapter = vi
      .fn()
      .mockRejectedValueOnce(new Error('native contact lost'))
      .mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter, identity, originalInstance)
    const request = () =>
      requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    await expect(request()).rejects.toThrow('native contact lost')
    expect(persist).not.toHaveBeenCalled()
    expect(await request()).toMatchObject({ outcome: 'accepted' })
  })

  it('does not persist an old operation after configuration replacement', async () => {
    const retirement = Promise.withResolvers<{ outcome: 'accepted' }>()
    configureOrcadDecommission(() => retirement.promise, identity, originalInstance)
    const first = requestOrcadManagedDecommission(
      { version, authority },
      version,
      identity.runtimeId
    )
    const replacement = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(replacement, identity, originalInstance)
    expect(
      await requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    ).toMatchObject({ code: 'orcad_decommission_operation_pending' })
    retirement.resolve({ outcome: 'accepted' })
    expect(await first).toMatchObject({ code: 'orcad_decommission_configuration_changed' })
    expect(persist).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('publishes a copied startup instance and clears it with the runtime configuration', () => {
    const instance = {
      pid: 123,
      startedAtMs: 10,
      nonce: 'startup-nonce',
      lockPath: '/host/orcad.lock'
    }
    configureOrcadDecommission(vi.fn(), identity, instance)
    instance.nonce = 'caller-mutated'
    const result = getOrcadManagedStopIdentity(identity.runtimeId, version)
    expect(result.instance).toEqual({ ...instance, nonce: 'startup-nonce' })
    result.instance!.pid = 456
    expect(getOrcadManagedStopIdentity(identity.runtimeId, version).instance?.pid).toBe(123)
    configureOrcadDecommission(null)
    expect(() => getOrcadManagedStopIdentity(identity.runtimeId, version)).toThrow(
      'identity_unavailable'
    )
  })

  it('pins startup identity and isolates published identity from caller mutation', () => {
    const configured = { ...identity }
    configureOrcadDecommission(vi.fn(), configured)
    configured.profileId = 'changed-active-profile'
    const published = getOrcadManagedStopIdentity(identity.runtimeId, version)
    expect(published).toEqual({ version, identity, completedStopReceipt: 1 })
    published.identity.profileId = 'caller-mutated'
    expect(getOrcadManagedStopIdentity(identity.runtimeId, version)).toEqual({
      version,
      identity,
      completedStopReceipt: 1
    })
    expect(() => getOrcadManagedStopIdentity('other-runtime', version)).toThrow(
      'identity_unavailable'
    )
  })

  it.each(['runtimeId', 'profileId', 'profileRoot'] as const)(
    'rejects a same-version request for another %s before reading or fencing anything',
    async (field) => {
      const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
      configureOrcadDecommission(adapter, identity)
      const result = await requestOrcadManagedDecommission(
        { version, authority: { ...authority, [field]: 'another-owner' } },
        version,
        identity.runtimeId
      )
      expect(result).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
      expect(adapter).not.toHaveBeenCalled()
      expect(validate).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
    }
  )

  it('requires the RPC runtime context to match the configured runtime too', async () => {
    const adapter = vi.fn()
    configureOrcadDecommission(adapter, identity)
    await expect(
      requestOrcadManagedDecommission({ version, authority }, version, 'runtime-b')
    ).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(adapter).not.toHaveBeenCalled()
  })

  it('does not let the legacy method bypass configured identity', async () => {
    const adapter = vi.fn()
    configureOrcadDecommission(adapter, identity)
    await expect(requestOrcadDecommission(version, version, transactionId)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(adapter).not.toHaveBeenCalled()
  })

  it('carries exact authority through preflight, retirement, persistence and receipt', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter, identity, originalInstance)
    await expect(
      requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    ).resolves.toEqual({ outcome: 'accepted', transactionId, authority })
    expect(validate).toHaveBeenCalledWith(transactionId, version, undefined, undefined, authority)
    expect(adapter).toHaveBeenCalledWith(authority)
    expect(Object.isFrozen(adapter.mock.calls[0][0])).toBe(true)
    expect(persist).toHaveBeenCalledWith(
      transactionId,
      version,
      undefined,
      'exact-transaction',
      authority
    )
    expect(validate.mock.invocationCallOrder[0]).toBeLessThan(adapter.mock.invocationCallOrder[0])
    expect(adapter.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0])
  })

  it('does not reinterpret a failed bound receipt as successful acceptance', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter, identity, originalInstance)
    persist.mockImplementation(() => {
      throw new Error('authority changed')
    })
    await expect(
      requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    ).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_decommission_receipt_unverifiable'
    })
  })

  it.each([undefined, { ...originalInstance, nonce: 'replacement' }])(
    'refuses a missing or replaced startup instance before fencing',
    async (instance) => {
      const adapter = vi.fn()
      configureOrcadDecommission(adapter, identity, instance)
      expect(
        await requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
      ).toMatchObject({ outcome: 'refused', code: 'orcad_decommission_transaction_unverifiable' })
      expect(adapter).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
    }
  )

  it('refuses a durable transaction that omits the original instance', async () => {
    const adapter = vi.fn()
    configureOrcadDecommission(adapter, identity, originalInstance)
    validate.mockReturnValue({ transactionSnapshot: 'old-transaction' })
    expect(
      await requestOrcadManagedDecommission({ version, authority }, version, identity.runtimeId)
    ).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(adapter).not.toHaveBeenCalled()
  })
})
