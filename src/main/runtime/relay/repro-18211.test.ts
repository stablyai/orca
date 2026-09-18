import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import { RelayAuthCoordinator, type RelayAuthContext } from './relay-auth-coordinator'
import { RelayDemandLedger } from './relay-demand-ledger'
import { RelayRevokeOutbox } from './relay-revoke-outbox'

const ownerIdentityKey = 'user-1\0profile-1\0org-1'
const relayHostId = 'relay-host-1'
const context: RelayAuthContext = {
  identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
  accessToken: 'access-1',
  relayEntitled: true
}

function liveBroker() {
  return {
    closeNow: vi.fn(),
    isLive: () => true,
    endpoint: { cellUrl: 'https://c1.relay.example.test' }
  }
}

// #18211: the host-level pairing connection mode must govern whether an
// already-paired `automatic` device may keep the desktop on Relay.
describe('#18211 LAN mode applies to already-paired devices', () => {
  afterEach(() => vi.useRealTimers())

  it('a standing relay binding stops being demand once the host picks LAN', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-repro-18211-'))
    const deviceRegistry = new DeviceRegistry(userDataPath)
    const revokeOutbox = new RelayRevokeOutbox(userDataPath)
    const phone = deviceRegistry.addDevice('Phone')
    deviceRegistry.setMobilePairingConnectionMode(phone.deviceId, 'automatic')
    deviceRegistry.setRelayBinding(phone.deviceId, {
      relayHostId,
      relayDeviceId: phone.deviceId,
      ownerIdentityKey
    })

    let hostMode: MobilePairingConnectionMode = 'automatic'
    const ledger = new RelayDemandLedger({
      deviceRegistry,
      revokeOutbox,
      relayHostId,
      isRelayAllowedForDevice: () => hostMode !== 'local-only'
    })
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)

    hostMode = 'local-only'
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)

    // In-flight work for a device the policy now excludes cannot outvote it.
    const release = ledger.acquireTransient(`endpoints:${phone.deviceId}`, phone.deviceId)
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
    release()

    hostMode = 'automatic'
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
  })

  it('a policy change withdraws the open relay session promptly instead of lingering', async () => {
    vi.useFakeTimers()
    let demanded = true
    const broker = liveBroker()
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: (status) => statuses.push(status)
    })
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    demanded = false
    coordinator.reconcile({ skipLinger: true })
    await coordinator.waitForLiveBroker()
    expect(statuses.at(-1)).toBe('standby')
    expect(broker.closeNow).toHaveBeenCalledOnce()
  })

  it('a policy change that failed transiently still skips the linger on its retry', async () => {
    // Why: the policy reconcile can hit a transient context-read failure; its
    // armed retry must carry skipLinger or the LAN pick lingers ten minutes.
    vi.useFakeTimers()
    let demanded = true
    let failNextRead = false
    const broker = liveBroker()
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => {
        if (failNextRead) {
          failNextRead = false
          throw new Error('transient session read failure')
        }
        return context
      },
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: vi.fn(),
      random: () => 0.5
    })
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    demanded = false
    failNextRead = true
    coordinator.reconcile({ skipLinger: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.closeNow).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(501)
    expect(broker.closeNow).toHaveBeenCalledOnce()
  })

  it('a queued revoke still holds the relay open under LAN until it flushes', () => {
    // Why: a revoke is server-side cleanup for a credential the user already
    // withdrew, not a grant; dropping it on a LAN pick would leave that
    // credential live on the relay until the user flipped back.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-repro-18211-'))
    const deviceRegistry = new DeviceRegistry(userDataPath)
    const revokeOutbox = new RelayRevokeOutbox(userDataPath)
    revokeOutbox.enqueue({ relayHostId, relayDeviceId: 'gone-phone', ownerIdentityKey })
    const ledger = new RelayDemandLedger({
      deviceRegistry,
      revokeOutbox,
      relayHostId,
      isRelayAllowedForDevice: () => false
    })

    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)
    for (const item of revokeOutbox.pendingFor(ownerIdentityKey, relayHostId)) {
      revokeOutbox.remove(item.reqId)
    }
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('pairing churn keeps the ten-minute linger', async () => {
    vi.useFakeTimers()
    let demanded = true
    const broker = liveBroker()
    const statuses: string[] = []
    const coordinator = new RelayAuthCoordinator({
      readContext: async () => context,
      hasDemand: () => demanded,
      openBroker: async () => broker,
      onStatus: (status) => statuses.push(status)
    })
    coordinator.reconcile()
    await expect(coordinator.waitForLiveBroker()).resolves.toBe(broker)

    demanded = false
    coordinator.reconcile()
    await coordinator.waitForLiveBroker()
    expect(statuses.at(-1)).toBe('standby')
    expect(broker.closeNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    expect(broker.closeNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(broker.closeNow).toHaveBeenCalledOnce()
  })
})
