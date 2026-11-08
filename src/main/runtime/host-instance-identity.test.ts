import { randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateE2EEKeypair, writeNewE2EEKeypair } from './rpc/server/pairing/e2ee-keypair'
import { DeviceRegistry } from './rpc/server/pairing/device-registry'
import {
  HOST_INSTALLATION_FILENAME,
  loadOrCreateHostInstallationId
} from './hosts/platform-probe/host-descriptor'
import { writeDurableSecureJsonFile } from '../../shared/secure-storage/secure-file'
import {
  ensureHostInstanceIdentity,
  hostInstanceIdFromEnv,
  HOST_INSTANCE_FILENAME,
  IDENTITY_BACKUPS_DIRNAME,
  rotateHostIdentity,
  type HostIdentityWrite
} from './host-instance-identity'
import { E2EE_KEYPAIR_FILENAME } from '../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
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

  it.each([
    ['the staged keypair', 'orca-e2ee-keypair.json.next'],
    ['the staged registry', `${DEVICE_REGISTRY_FILENAME}.next`],
    ['the rotating marker', HOST_INSTANCE_FILENAME]
  ])('keeps serving the old identity when writing %s fails', async (_label, failing) => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)

    expect(ensureHostInstanceIdentity(dir, vmB, failingWriteOf(failing))).toMatchObject({
      kind: 'kept'
    })
    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(before.publicKeyB64)
    expect(after.installationId).toBe(before.installationId)
    expect(after.registry.validateToken(before.token)).not.toBeNull()
    expect(readdirSync(dir).filter((name) => name.endsWith('.next'))).toEqual([])
    // The change is still pending, so a start that can write applies it.
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({
      kind: 'rotated',
      reason: 'instance_changed'
    })
  })

  it('keeps serving the old identity when the first id cannot be recorded', async () => {
    const before = await pairedHost(dir)
    expect(
      ensureHostInstanceIdentity(dir, vmA, failingWriteOf(HOST_INSTANCE_FILENAME))
    ).toMatchObject({ kind: 'kept' })
    expect((await identity(dir)).registry.validateToken(before.token)).not.toBeNull()
  })

  it('finishes a publish interrupted after the marker on the next start, without the variable', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)

    // Every staged file was moved into place; clearing `rotating` failed.
    const failFinalMarker: HostIdentityWrite = (path, value) => {
      if (path.endsWith(HOST_INSTANCE_FILENAME) && !JSON.stringify(value).includes('rotating')) {
        throw new Error('simulated crash clearing the marker')
      }
      return writeDurableSecureJsonFile(path, value)
    }
    expect(() => ensureHostInstanceIdentity(dir, vmB, failFinalMarker)).toThrow(/simulated crash/)

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

  it('publishes the rest of a staged identity after a crash between renames', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    // The keypair was already moved into place; the registry and installation id were not.
    const newKey = writeNewE2EEKeypair(dir, writeDurableSecureJsonFile).publicKeyB64
    writeDurableSecureJsonFile(join(dir, `${DEVICE_REGISTRY_FILENAME}.next`), [])
    const stagedInstallationId = randomUUID()
    writeDurableSecureJsonFile(join(dir, `${HOST_INSTALLATION_FILENAME}.next`), {
      installationId: stagedInstallationId
    })
    writeDurableSecureJsonFile(join(dir, HOST_INSTANCE_FILENAME), {
      v: 1,
      instanceId: vmB,
      rotating: true
    })

    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({
      kind: 'rotated',
      reason: 'interrupted_rotation'
    })
    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(newKey)
    expect(after.installationId).toBe(stagedInstallationId)
    expect(after.registry.validateToken(before.token)).toBeNull()
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({ kind: 'unchanged' })
  })

  it('finishes the rotation when the rotating marker is published but its write still fails', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    // For example the directory sync after the marker rename fails.
    const failAfterMarkerRename: HostIdentityWrite = (path, value) => {
      const result = writeDurableSecureJsonFile(path, value)
      if (path.endsWith(HOST_INSTANCE_FILENAME) && JSON.stringify(value).includes('rotating')) {
        throw new Error('simulated directory sync failure')
      }
      return result
    }

    expect(ensureHostInstanceIdentity(dir, vmB, failAfterMarkerRename)).toEqual({
      kind: 'rotated',
      reason: 'instance_changed'
    })
    const after = await identity(dir)
    expect(after.publicKeyB64).not.toBe(before.publicKeyB64)
    expect(after.registry.validateToken(before.token)).toBeNull()
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({ kind: 'unchanged' })
  })

  it('keeps the recorded id when a manual reset runs without ORCA_INSTANCE_ID', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    rotateHostIdentity(dir, null)
    const after = await identity(dir)
    expect(after.publicKeyB64).not.toBe(before.publicKeyB64)
    expect(ensureHostInstanceIdentity(dir, vmA)).toEqual({ kind: 'unchanged' })
    // A copy made after the reset and started with another id still rotates.
    expect(ensureHostInstanceIdentity(dir, vmB)).toMatchObject({ kind: 'rotated' })
  })

  it('finishes an interrupted rotation before a manual reset stages a new one', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    const failFinalMarker: HostIdentityWrite = (path, value) => {
      if (path.endsWith(HOST_INSTANCE_FILENAME) && !JSON.stringify(value).includes('rotating')) {
        throw new Error('simulated crash clearing the marker')
      }
      return writeDurableSecureJsonFile(path, value)
    }
    expect(() => ensureHostInstanceIdentity(dir, vmB, failFinalMarker)).toThrow(/simulated crash/)

    rotateHostIdentity(dir, null)
    const after = await identity(dir)
    expect(after.registry.validateToken(before.token)).toBeNull()
    expect(readdirSync(dir).filter((name) => name.endsWith('.next'))).toEqual([])
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({ kind: 'unchanged' })
  })

  it('moves the replaced identity into a backup folder and keeps the newest five', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    rotateHostIdentity(dir, vmA, writeDurableSecureJsonFile, () => new Date('2026-01-01T00:00:00Z'))

    const backups = join(dir, IDENTITY_BACKUPS_DIRNAME)
    const [first] = readdirSync(backups)
    expect(first).toMatch(/^2026-01-01T00-00-00-000Z-[0-9a-f]{6}$/)
    const saved = JSON.parse(readFileSync(join(backups, first, E2EE_KEYPAIR_FILENAME), 'utf8'))
    expect(saved.publicKeyB64).toBe(before.publicKeyB64)
    expect(readdirSync(join(backups, first)).sort()).toEqual(
      [E2EE_KEYPAIR_FILENAME, DEVICE_REGISTRY_FILENAME, HOST_INSTALLATION_FILENAME].sort()
    )

    for (let day = 2; day <= 7; day++) {
      rotateHostIdentity(
        dir,
        vmA,
        writeDurableSecureJsonFile,
        () => new Date(`2026-01-0${day}T00:00:00Z`)
      )
    }
    const kept = readdirSync(backups).sort()
    expect(kept).toHaveLength(5)
    expect(kept[0]).toMatch(/^2026-01-03/)
  })

  it('reports a reset as done when it finished an interrupted rotation but cannot stage another', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    const failFinalMarker: HostIdentityWrite = (path, value) => {
      if (path.endsWith(HOST_INSTANCE_FILENAME) && !JSON.stringify(value).includes('rotating')) {
        throw new Error('simulated crash clearing the marker')
      }
      return writeDurableSecureJsonFile(path, value)
    }
    expect(() => ensureHostInstanceIdentity(dir, vmB, failFinalMarker)).toThrow(/simulated crash/)

    expect(() =>
      rotateHostIdentity(dir, null, failingWriteOf('orca-e2ee-keypair.json.next'))
    ).not.toThrow()
    expect((await identity(dir)).registry.validateToken(before.token)).toBeNull()
    expect(readdirSync(dir).filter((name) => name.endsWith('.next'))).toEqual([])
    expect(ensureHostInstanceIdentity(dir, vmB)).toEqual({ kind: 'unchanged' })
  })

  it('never prunes the backup it just made', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    await pairedHost(dir)
    for (let day = 5; day <= 9; day++) {
      rotateHostIdentity(
        dir,
        vmA,
        writeDurableSecureJsonFile,
        () => new Date(`2027-01-0${day}T00:00:00Z`)
      )
    }
    // The clock went back (or the image carried later backups).
    rotateHostIdentity(dir, vmA, writeDurableSecureJsonFile, () => new Date('2026-01-01T00:00:00Z'))
    const kept = readdirSync(join(dir, IDENTITY_BACKUPS_DIRNAME)).sort()
    expect(kept).toHaveLength(5)
    expect(kept[0]).toMatch(/^2026-01-01/)
  })
})
