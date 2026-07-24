import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import {
  getRuntimeMetadataPath,
  MAX_RUNTIME_METADATA_FILE_BYTES,
  MAX_RUNTIME_METADATA_JSON_STRUCTURAL_TOKENS
} from '../../shared/runtime-bootstrap'
import {
  DeviceRegistry,
  DeviceRegistryCapacityError,
  MAX_DEVICE_REGISTRY_FILE_BYTES
} from './device-registry'
import {
  loadOrCreateE2EEKeypair,
  MAX_KEYPAIR_FILE_BYTES,
  MAX_KEYPAIR_JSON_STRUCTURAL_TOKENS
} from './e2ee-keypair'
import { readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'

describe('runtime control-file bounds', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function makeUserDataPath(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix))
    paths.push(path)
    return path
  }

  it('rejects oversized runtime metadata before parsing it', () => {
    const userDataPath = makeUserDataPath('orca-runtime-metadata-bound-')
    const metadataPath = getRuntimeMetadataPath(userDataPath)
    writeFileSync(metadataPath, '{"runtimeId":"runtime-1"}')
    truncateSync(metadataPath, MAX_RUNTIME_METADATA_FILE_BYTES + 1)

    expect(() => readRuntimeMetadata(userDataPath)).toThrow(NodeFileReadTooLargeError)
  })

  it('rejects structurally amplified runtime metadata before parsing it', () => {
    const userDataPath = makeUserDataPath('orca-runtime-metadata-structure-')
    const metadataPath = getRuntimeMetadataPath(userDataPath)
    writeFileSync(
      metadataPath,
      `{"transports":[${'0,'.repeat(MAX_RUNTIME_METADATA_JSON_STRUCTURAL_TOKENS)}0]}`
    )
    const parseSpy = vi.spyOn(JSON, 'parse')

    expect(() => readRuntimeMetadata(userDataPath)).toThrow('JSON structure exceeds')
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('preserves prior runtime metadata when serialization exceeds its read ceiling', () => {
    const userDataPath = makeUserDataPath('orca-runtime-metadata-write-')
    const metadataPath = getRuntimeMetadataPath(userDataPath)
    const initial = {
      runtimeId: 'runtime-1',
      pid: 42,
      transports: [],
      authToken: 'token',
      startedAt: 1
    }
    writeRuntimeMetadata(userDataPath, initial)
    const before = readFileSync(metadataPath, 'utf8')

    expect(() =>
      writeRuntimeMetadata(userDataPath, {
        ...initial,
        transports: [{ kind: 'unix', endpoint: 'x'.repeat(MAX_RUNTIME_METADATA_FILE_BYTES) }]
      })
    ).toThrow('JSON output exceeds')
    expect(readFileSync(metadataPath, 'utf8')).toBe(before)
  })

  it('treats an oversized device registry as unavailable', () => {
    const userDataPath = makeUserDataPath('orca-device-registry-bound-')
    const registryPath = join(userDataPath, 'orca-devices.json')
    writeFileSync(registryPath, '[]')
    truncateSync(registryPath, MAX_DEVICE_REGISTRY_FILE_BYTES + 1)

    expect(new DeviceRegistry(userDataPath).listDevices()).toEqual([])
  })

  it('rejects a byte-oversized device without publishing a partial credential', () => {
    const userDataPath = makeUserDataPath('orca-device-registry-write-bound-')
    const registry = new DeviceRegistry(userDataPath)

    expect(() => registry.addDevice('x'.repeat(MAX_DEVICE_REGISTRY_FILE_BYTES), 'mobile')).toThrow(
      DeviceRegistryCapacityError
    )
    expect(registry.listDevices()).toEqual([])
    expect(new DeviceRegistry(userDataPath).listDevices()).toEqual([])
  })

  it('regenerates an oversized E2EE keypair without loading it', () => {
    const userDataPath = makeUserDataPath('orca-keypair-bound-')
    const keypairPath = join(userDataPath, 'orca-e2ee-keypair.json')
    writeFileSync(keypairPath, '{"v":1}')
    truncateSync(keypairPath, MAX_KEYPAIR_FILE_BYTES + 1)

    expect(loadOrCreateE2EEKeypair(userDataPath).publicKey).toHaveLength(32)
    expect(statSync(keypairPath).size).toBeLessThan(MAX_KEYPAIR_FILE_BYTES)
  })

  it('regenerates a structurally amplified E2EE keypair before parsing it', () => {
    const userDataPath = makeUserDataPath('orca-keypair-structure-')
    const keypairPath = join(userDataPath, 'orca-e2ee-keypair.json')
    writeFileSync(keypairPath, `{"padding":[${'0,'.repeat(MAX_KEYPAIR_JSON_STRUCTURAL_TOKENS)}0]}`)
    const parseSpy = vi.spyOn(JSON, 'parse')

    expect(loadOrCreateE2EEKeypair(userDataPath).publicKey).toHaveLength(32)
    expect(parseSpy).not.toHaveBeenCalled()
  })
})
