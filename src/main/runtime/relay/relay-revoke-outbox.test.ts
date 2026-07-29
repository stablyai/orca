import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayRevokeOutbox } from './relay-revoke-outbox'

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
})
