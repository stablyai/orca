import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

const sendRequest = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: sendRequest }))

const {
  requestRemoteOrcadDecommission,
  readRemoteOrcadManagedStopIdentity,
  requestRemoteOrcadManagedDecommission,
  requestRemoteOrcadManagedStopCancellation
} = await import('./orcad-decommission-client')

const environment = {
  id: 'environment-1',
  name: 'Managed server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-1',
  preferredEndpointId: 'endpoint-1',
  endpoints: [
    {
      id: 'endpoint-1',
      kind: 'websocket',
      label: 'SSH tunnel',
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }
  ]
} satisfies KnownRuntimeEnvironment

beforeEach(() => vi.resetAllMocks())

const version = '0.2.0+new'
const authority = {
  runtimeId: 'runtime-1',
  profileId: 'profile-1',
  profileRoot: '/host/profile-1',
  transactionId: 'b407cda3-44bd-44d8-b75a-8268c18035b1'
}
const identity = {
  runtimeId: authority.runtimeId,
  profileId: authority.profileId,
  profileRoot: authority.profileRoot
}
const accepted = { outcome: 'accepted', transactionId: authority.transactionId, authority }

describe('prepared-stop cancellation transport', () => {
  const instance = { pid: 123, startedAtMs: null, nonce: 'original', lockPath: '/host/orcad.lock' }
  const request = { schemaVersion: 1 as const, version, authority, instance }
  const host = { version, identity, instance, cancelPreparedStop: 1 }
  const canceled = { ...request, outcome: 'canceled' }
  const cancel = () => requestRemoteOrcadManagedStopCancellation(environment, request)

  it('negotiates on the original instance and checks the exact cancellation receipt', async () => {
    sendRequest
      .mockResolvedValueOnce({ ok: true, result: host })
      .mockResolvedValueOnce({ ok: true, result: canceled })
    expect(await cancel()).toEqual(canceled)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      'orcad.managedStopIdentity',
      'orcad.cancelPreparedStop'
    ])
    expect(sendRequest.mock.calls[1][2]).toEqual(request)
  })

  it.each([
    { ...host, cancelPreparedStop: undefined },
    { ...host, instance: undefined },
    { ...host, instance: { ...instance, nonce: 'replacement' } },
    { ...host, identity: { ...identity, profileId: 'other' } }
  ])(
    'refuses unsupported or mismatched hosts without cancellation mutation (%#)',
    async (result) => {
      sendRequest.mockResolvedValueOnce({ ok: true, result })
      expect(await cancel()).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
      expect(sendRequest).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { ...canceled, version: 'other' },
    {
      ...canceled,
      authority: { ...authority, transactionId: '11111111-1111-4111-8111-111111111111' }
    },
    { ...canceled, instance: { ...instance, nonce: 'replacement' } },
    { outcome: 'canceled' }
  ])('refuses mismatched cancellation receipts without fallback (%#)', async (result) => {
    sendRequest
      .mockResolvedValueOnce({ ok: true, result: host })
      .mockResolvedValueOnce({ ok: true, result })
    expect(await cancel()).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps a lost cancellation response unverifiable', async () => {
    sendRequest
      .mockResolvedValueOnce({ ok: true, result: host })
      .mockRejectedValueOnce(new Error('connection lost'))
    expect(await cancel()).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})

describe('identity-bound managed stop transport', () => {
  it.each([null, '', ' '])(
    'requires a pinned runtime before any contact (%s)',
    async (runtimeId) => {
      const unpinned = { ...environment, runtimeId }
      expect(await readRemoteOrcadManagedStopIdentity(unpinned, version)).toMatchObject({
        verdict: 'unverifiable'
      })
      expect(
        await requestRemoteOrcadManagedDecommission(unpinned, version, authority)
      ).toMatchObject({ verdict: 'unverifiable' })
      expect(sendRequest).not.toHaveBeenCalled()
    }
  )

  it('reads identity through the saved authenticated pairing transport', async () => {
    sendRequest.mockResolvedValue({ ok: true, result: { version, identity } })
    expect(await readRemoteOrcadManagedStopIdentity(environment, version)).toEqual({
      outcome: 'verified',
      version,
      identity
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'ws://127.0.0.1:46768',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }),
      'orcad.managedStopIdentity',
      null,
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it.each([
    { version: 'wrong-version', identity },
    { version, identity: { ...identity, runtimeId: 'other' } },
    { version, identity: { runtimeId: 'runtime-1' } },
    null
  ])('refuses mismatched or malformed host identity (%#)', async (result) => {
    sendRequest.mockResolvedValue({ ok: true, result })
    expect(await readRemoteOrcadManagedStopIdentity(environment, version)).toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it('accepts only the exact bound receipt', async () => {
    sendRequest.mockResolvedValue({ ok: true, result: accepted })
    expect(await requestRemoteOrcadManagedDecommission(environment, version, authority)).toEqual(
      accepted
    )
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ deviceToken: 'token', publicKeyB64: 'key' }),
      'orcad.decommissionManagedIfIdle',
      { version, authority },
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it.each([
    { outcome: 'accepted' },
    { ...accepted, transactionId: '11111111-1111-4111-8111-111111111111' },
    ...(['runtimeId', 'profileId', 'profileRoot'] as const).map((field) => ({
      ...accepted,
      authority: { ...authority, [field]: 'other' }
    })),
    {
      ...accepted,
      authority: { ...authority, transactionId: '11111111-1111-4111-8111-111111111111' }
    }
  ])('refuses missing or mismatched bound receipts (%#)', async (result) => {
    sendRequest.mockResolvedValue({ ok: true, result })
    expect(
      await requestRemoteOrcadManagedDecommission(environment, version, authority)
    ).toMatchObject({ verdict: 'unverifiable' })
  })

  it('rejects authority for another runtime without sending a mutation', async () => {
    expect(
      await requestRemoteOrcadManagedDecommission(environment, version, {
        ...authority,
        runtimeId: 'other'
      })
    ).toMatchObject({ verdict: 'unverifiable' })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('never falls back to an older mutating method', async () => {
    sendRequest.mockResolvedValue({ ok: false, error: { message: 'method_not_found' } })
    expect(await readRemoteOrcadManagedStopIdentity(environment, version)).toMatchObject({
      verdict: 'unverifiable'
    })
    expect(
      await requestRemoteOrcadManagedDecommission(environment, version, authority)
    ).toMatchObject({ verdict: 'unverifiable' })
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      'orcad.managedStopIdentity',
      'orcad.decommissionManagedIfIdle'
    ])
  })

  it('snapshots caller authority before waiting for a receipt', async () => {
    let finish!: (value: unknown) => void
    sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const mutable = { ...authority }
    const pending = requestRemoteOrcadManagedDecommission(environment, version, mutable)
    mutable.profileId = 'replacement'
    finish({ ok: true, result: { ...accepted, authority: mutable } })
    expect(await pending).toMatchObject({ verdict: 'unverifiable' })
    expect(sendRequest.mock.calls[0][2].authority).toEqual(authority)
  })
})

describe('remote orcad decommission client', () => {
  it.each(['open', 'fenced', 'unverifiable', undefined])(
    'preserves optional admission evidence without inventing it (%s)',
    async (terminalAdmission) => {
      const result = {
        outcome: 'refused',
        verdict: 'live',
        code: 'busy',
        reason: 'Sessions remain live.',
        ...(terminalAdmission ? { terminalAdmission } : {})
      }
      sendRequest.mockResolvedValue({ ok: true, result })
      expect(await requestRemoteOrcadDecommission(environment, '0.2.0+new')).toEqual(result)
    }
  )
  it('parses an accepted host verdict', async () => {
    sendRequest.mockResolvedValue({ ok: true, result: { outcome: 'accepted' } })

    await expect(requestRemoteOrcadDecommission(environment, '0.2.0+new')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:46768' }),
      'orcad.decommissionIfIdle',
      { version: '0.2.0+new' },
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it('sends and validates an optional durable transaction receipt', async () => {
    const transactionId = 'b407cda3-44bd-44d8-b75a-8268c18035b1'
    sendRequest.mockResolvedValue({
      ok: true,
      result: { outcome: 'accepted', transactionId }
    })

    await expect(
      requestRemoteOrcadDecommission(environment, '0.2.0+new', transactionId)
    ).resolves.toEqual({ outcome: 'accepted', transactionId })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'orcad.decommissionIfIdle',
      { version: '0.2.0+new', transactionId },
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it.each([
    { ok: false, error: { message: 'method unavailable' } },
    { ok: true, result: { outcome: 'stopped' } }
  ])('fails closed for an unusable response', async (response) => {
    sendRequest.mockResolvedValue(response)

    await expect(requestRemoteOrcadDecommission(environment, '0.2.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable'
    })
  })
})
