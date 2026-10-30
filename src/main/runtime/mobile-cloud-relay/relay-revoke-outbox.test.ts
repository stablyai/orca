import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileModule from '../../../shared/secure-file'
import { RelayRevokeOutbox } from './relay-revoke-outbox'

const secureFileMocks = vi.hoisted(() => ({ failWrites: false }))

vi.mock('../../../shared/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileModule>()
  return {
    ...actual,
    writeSecureJsonFile: (targetPath: string, value: unknown) => {
      if (secureFileMocks.failWrites) {
        throw new Error('disk full')
      }
      actual.writeSecureJsonFile(targetPath, value)
    }
  }
})

describe('RelayRevokeOutbox', () => {
  const paths: string[] = []
  afterEach(() => {
    secureFileMocks.failWrites = false
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

  it('does not retain an enqueue that failed to reach disk', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const outbox = new RelayRevokeOutbox(path)
    secureFileMocks.failWrites = true
    expect(() => outbox.enqueue(binding)).toThrow('disk full')

    secureFileMocks.failWrites = false
    const persisted = outbox.enqueue(binding)
    expect(
      new RelayRevokeOutbox(path).pendingFor(binding.ownerIdentityKey, binding.relayHostId)
    ).toEqual([persisted])
  })

  it('does not remove an item in memory when the durable removal fails', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const outbox = new RelayRevokeOutbox(path)
    const item = outbox.enqueue(binding)
    secureFileMocks.failWrites = true
    expect(() => outbox.remove(item.reqId)).toThrow('disk full')

    secureFileMocks.failWrites = false
    expect(outbox.pendingFor(binding.ownerIdentityKey, binding.relayHostId)).toEqual([item])
  })
})
