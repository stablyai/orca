import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  serializeMobileWebManifestForBuildId,
  type MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import {
  MobileWebNativeStagingAdapter,
  type MobileWebNativeStagingApi
} from './mobile-web-native-staging-adapter'

describe('mobile web native staging adapter', () => {
  it('hands the store one complete asset and the manifest the build id hashes', async () => {
    const manifest = createManifest()
    const native = createNativeApi(manifest.buildId)
    const stager = new MobileWebNativeStagingAdapter(native, 'paired-public-key')
    const bytes = Buffer.from('Orca')

    await stager.writeAsset(manifest.buildId, manifest.assets[0]!, bytes)
    await expect(stager.commit(manifest)).resolves.toEqual({ buildId: manifest.buildId })

    expect(native.writeStagedAsset).toHaveBeenCalledWith(
      'paired-public-key',
      manifest.buildId,
      'index.html',
      bytes.toString('base64')
    )
    expect(native.commitGeneration).toHaveBeenCalledWith(
      'paired-public-key',
      manifest.buildId,
      serializeMobileWebManifestForBuildId(manifest)
    )
  })

  it('refuses a commit that published a different build', async () => {
    const manifest = createManifest()
    const native = createNativeApi('f'.repeat(64))
    const stager = new MobileWebNativeStagingAdapter(native, 'paired-public-key')

    await expect(stager.commit(manifest)).rejects.toThrow('mobile_web_generation_commit_mismatch')
  })

  it('aborts the staged tree by build id, with no stage handle to lose', async () => {
    const manifest = createManifest()
    const native = createNativeApi(manifest.buildId)
    const stager = new MobileWebNativeStagingAdapter(native, 'paired-public-key')

    await stager.abort(manifest.buildId)
    await stager.abort(manifest.buildId)

    expect(native.abortGeneration).toHaveBeenCalledTimes(2)
    expect(native.abortGeneration).toHaveBeenCalledWith('paired-public-key', manifest.buildId)
  })
})

function createNativeApi(buildId: string) {
  return {
    writeStagedAsset: vi.fn(async () => {}),
    commitGeneration: vi.fn(async () => ({ buildId })),
    abortGeneration: vi.fn(async () => {})
  } satisfies MobileWebNativeStagingApi
}

function createManifest(): MobileWebManifest {
  const bytes = Buffer.from('Orca')
  const seed: MobileWebManifest = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: {
      minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    },
    entrypoint: 'index.html',
    totalBytes: bytes.byteLength,
    assets: [
      {
        path: 'index.html',
        sha256: sha256Hex(bytes),
        byteLength: bytes.byteLength,
        contentType: 'text/html; charset=utf-8',
        role: 'document'
      }
    ]
  }
  return {
    ...seed,
    buildId: sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(seed)))
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
