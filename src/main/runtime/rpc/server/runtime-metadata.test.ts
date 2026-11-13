import '../../../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import nacl from 'tweetnacl'
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../../../shared/runtime-bootstrap'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { DeviceRegistry } from './pairing/device-registry'
import { loadOrCreateE2EEKeypair } from './pairing/e2ee-keypair'
import {
  clearRuntimeMetadata,
  clearRuntimeMetadataIfOwned,
  readRuntimeMetadata,
  writeRuntimeMetadata
} from './runtime-metadata'

const tempDirs: string[] = []

describe('runtime metadata', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      clearRuntimeMetadata(dir)
    }
  })

  describe('clearRuntimeMetadataIfOwned', () => {
    it('retains metadata when only the runtimeId differs', () => {
      // Auto-update may reuse a pid; runtimeId must still prevent treating the replacement as the old owner.
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)
      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_replacement',
        pid: 42,
        transports: [],
        authToken: null,
        startedAt: 200
      })

      clearRuntimeMetadataIfOwned(userDataPath, 42, 'rt_owner')

      expect(readRuntimeMetadata(userDataPath)).toMatchObject({
        pid: 42,
        runtimeId: 'rt_replacement'
      })
    })
  })

  it.runIf(process.platform !== 'win32')(
    'restricts runtime metadata permissions to the current user on Unix',
    () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)

      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_123',
        pid: 42,
        transports: [
          {
            kind: 'unix',
            endpoint: '/tmp/orca.sock'
          }
        ],
        authToken: 'secret',
        startedAt: 100
      })

      const metadataMode = statSync(getRuntimeMetadataPath(userDataPath)).mode & 0o777
      const directoryMode = statSync(userDataPath).mode & 0o777

      expect(metadataMode).toBe(0o600)
      expect(directoryMode).toBe(0o700)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'uses hardened atomic writes for runtime credential stores on Unix',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-secure-files-'))
      tempDirs.push(userDataPath)

      new DeviceRegistry(userDataPath).addDevice('phone')
      loadOrCreateE2EEKeypair(userDataPath)
      await addEnvironmentFromPairingCode(userDataPath, {
        name: 'desk',
        pairingCode: encodePairingOffer({
          v: 2,
          endpoint: 'ws://127.0.0.1:6768',
          deviceToken: 'device-token',
          publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
        })
      })

      for (const path of [
        join(userDataPath, 'orca-devices.json'),
        join(userDataPath, 'orca-e2ee-keypair.json'),
        getEnvironmentStorePath(userDataPath)
      ]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
      expect(statSync(userDataPath).mode & 0o777).toBe(0o700)
      expect(readdirSync(userDataPath).some((entry) => entry.endsWith('.tmp'))).toBe(false)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'hardens existing runtime credential stores before reading them on Unix',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-existing-secure-files-'))
      tempDirs.push(userDataPath)
      const keyMaterial = Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
      const pairingCode = encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: keyMaterial
      })
      const environment = await addEnvironmentFromPairingCode(userDataPath, {
        name: 'desk',
        pairingCode
      })

      const devicesPath = join(userDataPath, 'orca-devices.json')
      const keypairPath = join(userDataPath, 'orca-e2ee-keypair.json')
      const environmentsPath = getEnvironmentStorePath(userDataPath)
      writeFileSync(
        devicesPath,
        JSON.stringify([
          {
            deviceId: 'device-1',
            name: 'phone',
            token: 'token',
            pairedAt: 1,
            lastSeenAt: 0
          }
        ])
      )
      // Why derived: the loader advertises the public key of the stored secret.
      const storedPublicKeyB64 = Buffer.from(
        nacl.box.keyPair.fromSecretKey(Buffer.from(keyMaterial, 'base64')).publicKey
      ).toString('base64')
      writeFileSync(
        keypairPath,
        JSON.stringify({ v: 1, publicKeyB64: storedPublicKeyB64, secretKeyB64: keyMaterial })
      )
      for (const path of [devicesPath, keypairPath, environmentsPath]) {
        chmodSync(path, 0o644)
      }
      chmodSync(userDataPath, 0o755)

      expect(new DeviceRegistry(userDataPath).getDevice('device-1')).toMatchObject({
        token: 'token',
        scope: 'mobile'
      })
      expect(loadOrCreateE2EEKeypair(userDataPath).publicKeyB64).toBe(storedPublicKeyB64)
      expect((await listEnvironments(userDataPath))[0]?.id).toBe(environment.id)

      for (const path of [devicesPath, keypairPath, environmentsPath]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
      expect(statSync(userDataPath).mode & 0o777).toBe(0o700)
    }
  )
})
