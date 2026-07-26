import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES,
  MAX_RELAY_REVOKE_OUTBOX_ITEMS,
  RelayRevokeOutbox,
  RelayRevokeOutboxCapacityError,
  type RelayRevokeOutboxItem
} from './relay-revoke-outbox'

describe('RelayRevokeOutbox', () => {
  const paths: string[] = []
  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('durably retains an idempotent account-scoped revoke after local deletion', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const first = new RelayRevokeOutbox(path).enqueue(binding)
    const reloaded = new RelayRevokeOutbox(path)
    expect(reloaded.enqueue(binding).reqId).toBe(first.reqId)
    expect(reloaded.pendingFor(binding.ownerIdentityKey, binding.relayHostId)).toEqual([first])
    reloaded.remove(first.reqId)
    expect(
      new RelayRevokeOutbox(path).pendingFor(binding.ownerIdentityKey, binding.relayHostId)
    ).toEqual([])
  })

  it('treats an oversized sparse outbox file as unavailable', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-bound-'))
    paths.push(path)
    const outboxPath = join(path, 'mobile-relay-revoke-outbox.json')
    writeFileSync(outboxPath, '[]')
    truncateSync(outboxPath, MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES + 1)

    expect(new RelayRevokeOutbox(path).pendingFor('owner', 'host')).toEqual([])
  })

  it('fails closed instead of dropping revocations beyond the retained-item bound', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-count-'))
    paths.push(path)
    const items: RelayRevokeOutboxItem[] = Array.from(
      { length: MAX_RELAY_REVOKE_OUTBOX_ITEMS + 1 },
      (_, index) => ({
        reqId: `request-${index}`,
        relayHostId: 'host',
        relayDeviceId: `device-${index}`,
        ownerIdentityKey: 'owner',
        createdAt: index
      })
    )
    writeFileSync(join(path, 'mobile-relay-revoke-outbox.json'), JSON.stringify(items))

    expect(() => new RelayRevokeOutbox(path)).toThrow(RelayRevokeOutboxCapacityError)
  })

  it('keeps idempotent revokes usable at capacity and rejects only a new revoke', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-capacity-'))
    paths.push(path)
    const items: RelayRevokeOutboxItem[] = Array.from(
      { length: MAX_RELAY_REVOKE_OUTBOX_ITEMS },
      (_, index) => ({
        reqId: `request-${index}`,
        relayHostId: 'host',
        relayDeviceId: `device-${index}`,
        ownerIdentityKey: 'owner',
        createdAt: index
      })
    )
    writeFileSync(join(path, 'mobile-relay-revoke-outbox.json'), JSON.stringify(items))
    const outbox = new RelayRevokeOutbox(path)

    expect(outbox.enqueue(items[0]!).reqId).toBe(items[0]!.reqId)
    expect(() =>
      outbox.enqueue({ relayHostId: 'host', relayDeviceId: 'new', ownerIdentityKey: 'owner' })
    ).toThrow(RelayRevokeOutboxCapacityError)
  })

  it('rejects a byte-oversized revoke without publishing partial in-memory state', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-byte-capacity-'))
    paths.push(path)
    const outbox = new RelayRevokeOutbox(path)

    expect(() =>
      outbox.enqueue({
        relayHostId: 'host',
        relayDeviceId: 'device',
        ownerIdentityKey: 'x'.repeat(MAX_RELAY_REVOKE_OUTBOX_FILE_BYTES)
      })
    ).toThrow(RelayRevokeOutboxCapacityError)
    expect(outbox.pendingFor('owner', 'host')).toEqual([])
    expect(new RelayRevokeOutbox(path).pendingFor('owner', 'host')).toEqual([])
  })
})
