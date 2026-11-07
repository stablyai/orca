import { describe, expect, it, vi } from 'vitest'
import { getPairingFailureMessage } from '../pairing/pairing-failure-message'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { PairingCodeRejectedError, racePairingCandidates } from './pairing-candidate-race'
import { AUTH_REJECTED } from './rpc-client-authentication-retry'
import type { Translate } from '../i18n/mobile-i18n'

function failing(error: Error) {
  return { sendRequest: vi.fn().mockRejectedValue(error), close: vi.fn() }
}

const t: Translate = (_key, fallback, values) =>
  fallback.replace('{{error}}', String(values?.error ?? ''))

describe('first pairing rejected by the desktop', () => {
  it('reports an expired or replaced code when any path was refused', async () => {
    const race = racePairingCandidates([
      { path: 'direct', client: failing(new Error('connect ECONNREFUSED')) },
      { path: 'relay', client: failing(new MobileE2EEAuthenticationError()) }
    ])
    const error = await race.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PairingCodeRejectedError)
    expect(
      getPairingFailureMessage({ screen: 'scan', error, timedOut: false, timeoutMs: 1, t })
    ).toBe(
      'This pairing code expired or was replaced. Show a new code on your desktop and scan again.'
    )
  })

  it.each(['direct', 'iroh'] as const)('recognizes the %s client refusal', async (path) => {
    const race = racePairingCandidates([{ path, client: failing(new Error(AUTH_REJECTED)) }])
    await expect(race).rejects.toBeInstanceOf(PairingCodeRejectedError)
  })

  it.each([
    ['direct', 'direct and relay pairing paths both failed'],
    ['iroh', 'iroh pairing path failed']
  ] as const)('keeps the generic failure for %s network errors', async (path, message) => {
    const error = await racePairingCandidates([
      { path, client: failing(new Error('connect ECONNREFUSED')) }
    ]).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(PairingCodeRejectedError)
    expect(
      getPairingFailureMessage({ screen: 'confirm', error, timedOut: false, timeoutMs: 1, t })
    ).toBe(`Pairing failed: ${message}`)
  })
})
