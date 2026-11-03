import { beforeEach, expect, it, vi } from 'vitest'
import type { PairingOffer } from './types'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import { writeEndpointAuthHeaders } from './endpoint-auth-headers-store'
import {
  markHostCredentialWrite,
  resetHostCredentialWriteRevisionsForTests
} from './host-credential-write-revision'
import { startPairingWithEdgeAuth } from './pairing-edge-auth-attempt'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./pre-profile-pairing-coordinator', () => ({ startPreProfilePairing: vi.fn() }))
vi.mock('./endpoint-auth-headers-store', () => ({ writeEndpointAuthHeaders: vi.fn() }))
const offer: PairingOffer = {
  v: 2,
  endpoint: 'wss://orca.example/path',
  deviceToken: 'synthetic-device',
  publicKeyB64: 'synthetic-key'
}
const headers = { 'CF-Access-Client-Secret': 'synthetic-secret' }
let current = true
const dispose = vi.fn()
function start(input = headers) {
  return startPairingWithEdgeAuth({
    offer,
    timeoutMs: 25000,
    headers: input,
    isCurrent: () => current
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  resetHostCredentialWriteRevisionsForTests()
  current = true
  vi.mocked(startPreProfilePairing).mockReturnValue({
    result: Promise.resolve({ hostId: 'host-1' }),
    timedOut: false,
    dispose
  })
  vi.mocked(writeEndpointAuthHeaders).mockImplementation(async (hostId) => {
    markHostCredentialWrite(hostId)
  })
})

it('passes a header snapshot to direct pairing and saves only after the verified host result', async () => {
  const attempt = start()
  expect(writeEndpointAuthHeaders).not.toHaveBeenCalled()
  expect(startPreProfilePairing).toHaveBeenCalledWith(
    expect.objectContaining({ connectOptions: { edgeAuthHeaders: headers } })
  )
  await expect(attempt.result).resolves.toEqual({ hostId: 'host-1', credentialsSaved: true })
  expect(writeEndpointAuthHeaders).toHaveBeenCalledWith(
    'host-1',
    headers,
    offer.endpoint,
    expect.any(Function)
  )
  attempt.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
})
it('keeps the verified host and retries only credential storage after failure', async () => {
  vi.mocked(writeEndpointAuthHeaders).mockRejectedValueOnce(
    new Error('native synthetic-secret failure')
  )
  const attempt = start()
  await expect(attempt.result).resolves.toEqual({ hostId: 'host-1', credentialsSaved: false })
  await expect(attempt.retryCredentialSave()).resolves.toBeUndefined()
  expect(startPreProfilePairing).toHaveBeenCalledTimes(1)
  expect(writeEndpointAuthHeaders).toHaveBeenCalledTimes(2)
})
it('returns only a static error when another credential retry fails', async () => {
  vi.mocked(writeEndpointAuthHeaders).mockRejectedValue(
    new Error('native synthetic-secret failure')
  )
  const attempt = start()
  await attempt.result
  await expect(attempt.retryCredentialSave()).rejects.toThrow('Could not save edge authentication')
})
it('does not save headers after verification failure', async () => {
  vi.mocked(startPreProfilePairing).mockReturnValue({
    result: Promise.reject(new Error('identity failed')),
    timedOut: false,
    dispose
  })
  await expect(start().result).rejects.toThrow()
  expect(writeEndpointAuthHeaders).not.toHaveBeenCalled()
})
it('does not save after route cancellation while pairing completes', async () => {
  const attempt = start()
  current = false
  attempt.dispose()
  await expect(attempt.result).rejects.toThrow('Pairing cancelled')
  expect(writeEndpointAuthHeaders).not.toHaveBeenCalled()
})
it('refuses a storage-only retry after another pairing writes credentials', async () => {
  vi.mocked(writeEndpointAuthHeaders).mockRejectedValueOnce(new Error('locked'))
  const attempt = start()
  await attempt.result
  markHostCredentialWrite('host-1')
  await expect(attempt.retryCredentialSave()).rejects.toThrow('Pairing cancelled')
  expect(writeEndpointAuthHeaders).toHaveBeenCalledTimes(1)
})
it('leaves existing credentials alone when no headers were entered', async () => {
  const attempt = startPairingWithEdgeAuth({
    offer,
    timeoutMs: 25000,
    headers: null,
    isCurrent: () => true
  })
  await expect(attempt.result).resolves.toEqual({ hostId: 'host-1', credentialsSaved: true })
  expect(writeEndpointAuthHeaders).not.toHaveBeenCalled()
})
it.each(['ws://orca.example', 'https://orca.example'])(
  'rejects headers for %s before creating a candidate',
  (endpoint) => {
    expect(() =>
      startPairingWithEdgeAuth({
        offer: { ...offer, endpoint },
        timeoutMs: 25000,
        headers,
        isCurrent: () => true
      })
    ).toThrow('secure WSS')
    expect(startPreProfilePairing).not.toHaveBeenCalled()
  }
)

it('does not save edge credentials when host persistence finishes after pairing timed out', async () => {
  vi.mocked(startPreProfilePairing).mockReturnValue({
    result: Promise.resolve({ hostId: 'host-1' }),
    timedOut: true,
    dispose
  })
  const attempt = start()
  await expect(attempt.result).rejects.toThrow('Pairing cancelled')
  expect(attempt.timedOut).toBe(true)
  expect(writeEndpointAuthHeaders).not.toHaveBeenCalled()
})
