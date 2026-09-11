import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { RelayDemandLedger } from './relay-demand-ledger'
import {
  RELAY_REVOKE_DEMAND_WINDOW_MS,
  RelayRevokeOutbox,
  type RelayDeviceBinding
} from './relay-revoke-outbox'
import { DesktopRelayService } from './desktop-relay-service'

// What this pins: a revoke that can never succeed must not hold relay demand forever.
//
// `hasDemand` counts a pending revoke deliberately unfiltered by the host's pairing-connection
// policy — the credential has to be killed on the relay whatever the user has since chosen. That
// is right for a revoke that can still land, and wrong for one that never will: the item is only
// removed on a SUCCESSFUL flush, and `flushRevoke` swallowed every failure with no attempt cap and
// no expiry. A permanently-rejected revoke therefore pinned demand true for the life of the
// install and defeated a `local-only` pick entirely (#19870's regression path).

const ownerIdentityKey = 'user-1\0profile-1\0org-1'
const relayHostId = 'relay-host-1'

function fixture(now: () => number) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
  const deviceRegistry = new DeviceRegistry(userDataPath)
  const revokeOutbox = new RelayRevokeOutbox(userDataPath)
  const ledger = new RelayDemandLedger({ deviceRegistry, revokeOutbox, relayHostId, now })
  return { deviceRegistry, revokeOutbox, ledger }
}

function binding(relayDeviceId: string): RelayDeviceBinding {
  return { relayDeviceId, relayHostId, ownerIdentityKey }
}

/** A broker whose revoke is rejected permanently, the way a deleted device or a revoked
 *  credential is rejected: the server is reachable and says no, every time. */
function permanentlyFailingBroker(revokeDevice: ReturnType<typeof vi.fn>) {
  return { ownerIdentityKey, hostId: relayHostId, revokeDevice } as never
}

function serviceOver(revokeOutbox: RelayRevokeOutbox, ledger: RelayDemandLedger) {
  const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
  Object.assign(service, {
    revokeOutbox,
    demandLedger: ledger,
    coordinator: { reconcile: vi.fn(), ensureLive: vi.fn(), getActiveBroker: () => null },
    stopped: false,
    livenessTimer: null,
    demandExpiryTimer: null
  })
  return service as unknown as { flushRevokeOutbox: (broker: unknown) => Promise<void> }
}

describe('a revoke that can never succeed', () => {
  it('stops pinning relay demand once its window passes, but is never abandoned', async () => {
    let now = 0
    const { revokeOutbox, ledger } = fixture(() => now)
    // Anchor the injected clock to the item's own `createdAt`. Reading Date.now() separately races
    // enqueue's real-clock stamp, and under load the drift silently eats into the window.
    now = revokeOutbox.enqueue(binding('device-1')).createdAt
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)

    const revokeDevice = vi.fn().mockRejectedValue(new Error('device_not_found'))
    const service = serviceOver(revokeOutbox, ledger)

    // Every reconnect re-drives the outbox against the same stable reqId.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await service.flushRevokeOutbox(permanentlyFailingBroker(revokeDevice))
    }
    // Inside the window the relay is still held up on purpose: the revoke may yet land.
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(true)

    now += RELAY_REVOKE_DEMAND_WINDOW_MS + 1
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)

    // The intent is NOT discarded. Dropping it would leave a live credential on the relay with
    // nothing left to kill it, so the item stays and keeps retrying on any future connection.
    expect(revokeOutbox.pendingFor(ownerIdentityKey, relayHostId)).toHaveLength(1)
    const callsBefore = revokeDevice.mock.calls.length
    await service.flushRevokeOutbox(permanentlyFailingBroker(revokeDevice))
    expect(revokeDevice.mock.calls.length).toBe(callsBefore + 1)
  })

  it('still lets a revoke that lands remove the item and release demand', async () => {
    let now = 0
    const { revokeOutbox, ledger } = fixture(() => now)
    // Anchor the injected clock to the item's own `createdAt`. Reading Date.now() separately races
    // enqueue's real-clock stamp, and under load the drift silently eats into the window.
    now = revokeOutbox.enqueue(binding('device-1')).createdAt
    const revokeDevice = vi.fn().mockResolvedValue(undefined)
    const service = serviceOver(revokeOutbox, ledger)

    await service.flushRevokeOutbox(permanentlyFailingBroker(revokeDevice))

    expect(revokeDevice).toHaveBeenCalledTimes(1)
    expect(revokeOutbox.pendingFor(ownerIdentityKey, relayHostId)).toHaveLength(0)
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
    // And it was removed on success, not merely aged out.
    now += RELAY_REVOKE_DEMAND_WINDOW_MS + 1
    expect(ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })
})
