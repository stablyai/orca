import { randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
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
  rotateHostIdentity,
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

  it('rotates the identity and clears pairings when ORCA_INSTANCE_ID changes', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const source = await pairedHost(dir)
    const clone = mkdtempSync(join(tmpdir(), 'orca-host-instance-clone-'))
    cpSync(dir, clone, { recursive: true })

    ensureHostInstanceIdentity(clone, vmB)
    const rotated = await identity(clone)
    expect(rotated.publicKeyB64).not.toBe(source.publicKeyB64)
    expect(rotated.installationId).not.toBe(source.installationId)
    expect(rotated.registry.validateToken(source.token)).toBeNull()

    // The source keeps its own identity.
    expect((await identity(dir)).registry.validateToken(source.token)).not.toBeNull()
  })

  it('keeps the old identity when writing the staged registry fails', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)

    expect(
      ensureHostInstanceIdentity(dir, vmB, failingWriteOf(`${DEVICE_REGISTRY_FILENAME}.next`))
    ).toMatchObject({
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

  it('deletes files staged by a rotation that crashed before its marker, keeping the identity', async () => {
    ensureHostInstanceIdentity(dir, vmA)
    const before = await pairedHost(dir)
    // A crash mid-staging leaves `.next` files (one holds a secret key) and no `rotating` marker.
    writeNewE2EEKeypair(dir, (path, value) => writeDurableSecureJsonFile(`${path}.next`, value))
    writeDurableSecureJsonFile(join(dir, `${DEVICE_REGISTRY_FILENAME}.next`), [])

    ensureHostInstanceIdentity(dir, vmA)
    expect(readdirSync(dir).filter((name) => name.endsWith('.next'))).toEqual([])
    const after = await identity(dir)
    expect(after.publicKeyB64).toBe(before.publicKeyB64)
    expect(after.registry.validateToken(before.token)).not.toBeNull()
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
  })
})
