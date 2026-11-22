import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { devicePrincipalOf, fingerprintAuthenticatedPairingCredential } from './device-principal'
import { PairingTicketExchangeError } from './pairing-ticket-exchange'
import './mobile-pairing-files'

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

  it('retires a runtime link once a browser signs in with its saved key, but not a session-only key', () => {
    const registry = new DeviceRegistry(dir)
    const link = registry.getOrCreatePendingDevice('Runtime', 'runtime')
    registry.updateLastSeen(link.deviceId)
    const sessionOnly = registry.forkDeviceKey(
      link.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab',
      {
        ephemeral: true
      }
    )
    registry.retireForkedTicket(sessionOnly.deviceId)
    expect(registry.validateToken(link.token)?.deviceId).toBe(link.deviceId)

    const saved = registry.forkDeviceKey(
      link.deviceId,
      Buffer.alloc(32, 2).toString('base64'),
      'Chrome'
    )
    // Registration alone does not retire it: a lost reply is retried with the link.
    expect(registry.validateToken(link.token)?.deviceId).toBe(link.deviceId)
    registry.retireForkedTicket(saved.deviceId)

    expect(registry.validateToken(link.token)).toBeNull()
    expect(registry.lookupDeviceKey(saved.deviceId).kind).toBe('found')
    expect(registry.lookupDeviceKey(sessionOnly.deviceId).kind).toBe('found')
    expect(devicePrincipalOf(registry.getDevice(link.deviceId)!).callerFingerprint).toBe(
      fingerprintAuthenticatedPairingCredential(link.token)
    )
    expect(new DeviceRegistry(dir).validateToken(link.token)).toBeNull()
  })

  it('a browser key does not retire a link another client already claimed or that served for a while', () => {
    const registry = new DeviceRegistry(dir)
    const claimed = registry.getOrCreatePendingDevice('Runtime', 'runtime')
    registry.updateLastSeen(claimed.deviceId)
    registry.exchangePairingTicket(claimed.deviceId, claimed.token, REPLACEMENT)
    const browser = registry.forkDeviceKey(
      claimed.deviceId,
      Buffer.alloc(32, 5).toString('base64'),
      'Chrome'
    )
    registry.retireForkedTicket(browser.deviceId)
    // The desktop that proposed first can still sign in with its own token.
    expect(registry.validateToken(REPLACEMENT)?.deviceId).toBe(claimed.deviceId)
    expect(registry.lookupDeviceKey(browser.deviceId).kind).toBe('found')

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(2_000_000)
      const shared = registry.addDevice('Shared link', 'runtime')
      registry.updateLastSeen(shared.deviceId)
      vi.setSystemTime(2_000_000 + 10 * 60_000 + 1)
      const late = registry.forkDeviceKey(
        shared.deviceId,
        Buffer.alloc(32, 6).toString('base64'),
        'Firefox'
      )
      registry.retireForkedTicket(late.deviceId)
      expect(registry.validateToken(shared.token)?.deviceId).toBe(shared.deviceId)
    } finally {
      vi.useRealTimers()
    }
  })
})
