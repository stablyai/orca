import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { devicePrincipalOf, fingerprintAuthenticatedPairingCredential } from './device-principal'
import { PairingTicketExchangeError } from './pairing-ticket-exchange'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

const REPLACEMENT = 'a'.repeat(48)
const RETRY = 'b'.repeat(48)
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-ticket-exchange-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pairedOffer(registry: DeviceRegistry) {
  const offer = registry.getOrCreatePendingDevice('Phone', 'mobile')
  registry.updateLastSeen(offer.deviceId)
  return offer
}

function expectExchangeError(run: () => void, code: PairingTicketExchangeError['code']): void {
  let thrown: unknown = null
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown instanceof PairingTicketExchangeError ? thrown.code : thrown).toBe(code)
}

describe('pairing ticket exchange', () => {
  it('mints every new offer as a ticket', () => {
    const registry = new DeviceRegistry(dir)
    expect(registry.getOrCreatePendingDevice('Phone', 'mobile').ticket).toBe(true)
    expect(registry.addDevice('CLI', 'runtime').ticket).toBe(true)
  })

  it('keeps the pairing token until the replacement is first used, then retires it', () => {
    const registry = new DeviceRegistry(dir)
    const offer = pairedOffer(registry)
    registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT)
    // Lost reply: the client still has only the pairing token, which still works.
    expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)

    const signedIn = registry.validateToken(REPLACEMENT)
    expect(signedIn).toMatchObject({ deviceId: offer.deviceId, token: REPLACEMENT })
    expect(signedIn?.ticket).toBeUndefined()
    expect(signedIn?.exchangeToken).toBeUndefined()
    expect(registry.validateToken(offer.token)).toBeNull()

    // Same pairing for orchestration ownership; sockets still on the pairing token are cut.
    const principal = devicePrincipalOf(signedIn!)
    expect(principal.callerFingerprint).toBe(fingerprintAuthenticatedPairingCredential(offer.token))
    expect(principal.credentialRevision).toBe(1)
    expect(
      registry.resolveAuthenticatedPrincipal({
        deviceId: offer.deviceId,
        credentialRevision: 0,
        deviceToken: offer.token
      })
    ).toBeNull()

    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.validateToken(REPLACEMENT)?.deviceId).toBe(offer.deviceId)
    expect(reloaded.validateToken(offer.token)).toBeNull()
  })

  it('persists the proposal before replying; a resend is idempotent and a second client cannot take over', () => {
    const registry = new DeviceRegistry(dir)
    const offer = pairedOffer(registry)
    registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT)
    registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT)
    // Another client holding the same code keeps using it; the first proposal is never displaced.
    expectExchangeError(
      () => registry.exchangePairingTicket(offer.deviceId, offer.token, RETRY),
      'ticket_exchange_pending'
    )

    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    expect(reloaded.validateToken(RETRY)).toBeNull()
    expect(reloaded.validateToken(REPLACEMENT)?.token).toBe(REPLACEMENT)
    expect(reloaded.validateToken(offer.token)).toBeNull()
  })

  it('never retires a code that has already served as a plain token for a while', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000_000)
      const registry = new DeviceRegistry(dir)
      const offer = pairedOffer(registry)
      vi.setSystemTime(1_000_000 + 10 * 60_000 + 1)
      expectExchangeError(
        () => registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT),
        'ticket_window_closed'
      )
      expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses rows that are not exchangeable tickets', () => {
    const registry = new DeviceRegistry(dir)
    const offer = pairedOffer(registry)
    expectExchangeError(
      () => registry.exchangePairingTicket('missing', offer.token, REPLACEMENT),
      'device_not_found'
    )
    // Only the pairing token itself may propose.
    expectExchangeError(
      () => registry.exchangePairingTicket(offer.deviceId, 'f'.repeat(48), REPLACEMENT),
      'ticket_already_exchanged'
    )
    expectExchangeError(
      () => registry.exchangePairingTicket(offer.deviceId, offer.token, offer.token),
      'device_token_in_use'
    )
    registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT)
    registry.validateToken(REPLACEMENT)
    expectExchangeError(
      () => registry.exchangePairingTicket(offer.deviceId, REPLACEMENT, RETRY),
      'not_a_ticket'
    )
  })

  it('leaves pairings made before tickets, and phones paired through a desktop, as they are', () => {
    const row = { name: 'Phone', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 }
    writeFileSync(
      join(dir, DEVICE_REGISTRY_FILENAME),
      JSON.stringify([
        { ...row, deviceId: 'legacy', token: 'legacy-token' },
        { ...row, deviceId: 'desktop', token: 'desktop-token', scope: 'runtime' },
        {
          ...row,
          deviceId: 'child',
          token: 'child-token',
          parentDeviceId: 'desktop',
          ticket: true
        }
      ])
    )
    const registry = new DeviceRegistry(dir)
    expectExchangeError(
      () => registry.exchangePairingTicket('legacy', 'legacy-token', REPLACEMENT),
      'not_a_ticket'
    )
    expectExchangeError(
      () => registry.exchangePairingTicket('child', 'child-token', REPLACEMENT),
      'delegated_device'
    )
    expect(registry.validateToken('legacy-token')?.deviceId).toBe('legacy')
  })

  it('keeps both tokens working when retiring the pairing token cannot be saved', () => {
    const registry = new DeviceRegistry(dir)
    const offer = pairedOffer(registry)
    registry.exchangePairingTicket(offer.deviceId, offer.token, REPLACEMENT)
    const save = registry['save'].bind(registry)
    registry['save'] = vi.fn(() => {
      throw new Error('disk full')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const signedIn = registry.validateToken(REPLACEMENT)
    expect(signedIn).toMatchObject({ deviceId: offer.deviceId, token: REPLACEMENT })
    // The replacement socket stays authenticated on later requests.
    expect(
      registry.resolveAuthenticatedPrincipal({
        deviceId: offer.deviceId,
        credentialRevision: devicePrincipalOf(signedIn!).credentialRevision,
        deviceToken: REPLACEMENT
      })
    ).not.toBeNull()
    expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)

    registry['save'] = save
    registry.validateToken(REPLACEMENT)
    expect(registry.validateToken(offer.token)).toBeNull()
  })
})
