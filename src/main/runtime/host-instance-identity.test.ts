import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { DeviceRegistry } from './rpc/server/pairing/device-registry'
import { loadOrCreateHostInstallationId } from './hosts/platform-probe/host-descriptor'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  ensureHostInstanceIdentity,
  hostInstanceIdFromEnv,
  HOST_INSTANCE_FILENAME,
  type HostIdentityWrite
} from './host-instance-identity'
import { DEVICE_REGISTRY_FILENAME } from './rpc/server/pairing/mobile-pairing-files'

const vmA = hostInstanceIdFromEnv({ ORCA_INSTANCE_ID: 'vm-a' })
const vmB = hostInstanceIdFromEnv({ ORCA_INSTANCE_ID: 'vm-b' })

/** What pairing serves after one startup. */
async function identity(dir: string) {
  return {
    publicKeyB64: loadOrCreateE2EEKeypair(dir).publicKeyB64,
    registry: new DeviceRegistry(dir),
    installationId: await loadOrCreateHostInstallationId(dir)
  }
}

async function pairedHost(dir: string) {
  const host = await identity(dir)
  const { token } = host.registry.addDevice('Phone')
  host.registry.flushPendingLastSeen()
  return { ...host, token }
}

function failingWriteOf(filename: string): HostIdentityWrite {
  return (path, value) => {
    if (path.endsWith(filename)) {
      throw new Error(`simulated crash writing ${filename}`)
    }
    return writeDurableSecureJsonFile(path, value)
  }
}

describe('ensureHostInstanceIdentity', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-instance-'))
  })

  it('never rotates while ORCA_INSTANCE_ID is unset, even with an id recorded', async () => {
    const before = await pairedHost(dir)
    expect(ensureHostInstanceIdentity(dir, null)).toEqual({ kind: 'unchanged' })
    ensureHostInstanceIdentity(dir, vmA)
    expect(ensureHostInstanceIdentity(dir, null)).toEqual({ kind: 'unchanged' })

    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(before.publicKeyB64)
    expect(after.installationId).toBe(before.installationId)
    expect(after.registry.validateToken(before.token)).not.toBeNull()
  })

  it('only records the first ORCA_INSTANCE_ID on an existing install', async () => {
    const before = await pairedHost(dir)
    expect(ensureHostInstanceIdentity(dir, vmA)).toEqual({ kind: 'recorded' })
    expect(ensureHostInstanceIdentity(dir, vmA)).toEqual({ kind: 'unchanged' })

    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(before.publicKeyB64)
    expect(after.registry.validateToken(before.token)).not.toBeNull()
    expect(readFileSync(join(dir, HOST_INSTANCE_FILENAME), 'utf8')).not.toContain('vm-a')
  })

  it('rotates the identity and clears pairings when ORCA_INSTANCE_ID changes', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const source = await pairedHost(dir)
    const clone = mkdtempSync(join(tmpdir(), 'orca-host-instance-clone-'))
    cpSync(dir, clone, { recursive: true })

    expect(ensureHostInstanceIdentity(clone, vmB)).toEqual({
      kind: 'rotated',
      reason: 'instance_changed'
    })
    const rotated = await identity(clone)
    expect(rotated.publicKeyB64).not.toBe(source.publicKeyB64)
    expect(rotated.installationId).not.toBe(source.installationId)
    expect(rotated.registry.validateToken(source.token)).toBeNull()
    expect(rotated.registry.listDevices()).toEqual([])

    expect(ensureHostInstanceIdentity(clone, vmB)).toEqual({ kind: 'unchanged' })
    expect((await identity(clone)).publicKeyB64).toBe(rotated.publicKeyB64)
    // The source keeps its own identity.
    expect((await identity(dir)).registry.validateToken(source.token)).not.toBeNull()
  })

  it('keeps the old identity when a rotation fails before it starts', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)

    expect(() =>
      ensureHostInstanceIdentity(dir, vmB, failingWriteOf(HOST_INSTANCE_FILENAME))
    ).toThrow(/simulated crash/)
    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(before.publicKeyB64)
    expect(after.registry.validateToken(before.token)).not.toBeNull()
  })

  it('finishes a rotation interrupted between files on the next start, even without the variable', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)

    // The new keypair landed, the registry did not.
    expect(() =>
      ensureHostInstanceIdentity(dir, vmB, failingWriteOf(DEVICE_REGISTRY_FILENAME))
    ).toThrow(/simulated crash/)

    expect(ensureHostInstanceIdentity(dir, null)).toEqual({
      kind: 'rotated',
      reason: 'interrupted_rotation'
    })
    const after = await identity(dir)
    expect(after.publicKeyB64).not.toBe(before.publicKeyB64)
    expect(after.installationId).not.toBe(before.installationId)
    expect(after.registry.validateToken(before.token)).toBeNull()
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({ kind: 'unchanged' })
  })
})
