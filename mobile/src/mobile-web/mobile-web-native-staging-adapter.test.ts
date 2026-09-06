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
  it('passes canonical package identity and verified chunks to the native cache', async () => {
    const manifest = createManifest()
    const native = createNativeApi(manifest.buildId)
    const stager = new MobileWebNativeStagingAdapter(native, 'paired-public-key')
    const asset = manifest.assets[0]!
    const bytes = Buffer.from('Orca')

    await stager.begin(manifest)
    await stager.writeAssetChunk(asset, 0, bytes)
    await stager.finishAsset(asset)
    await expect(stager.commit(manifest)).resolves.toEqual({ buildId: manifest.buildId })

    expect(native.beginStage).toHaveBeenCalledWith(
      'paired-public-key',
      JSON.stringify(manifest),
      serializeMobileWebManifestForBuildId(manifest)
    )
    expect(native.writeAssetChunk).toHaveBeenCalledWith(
      'stage-id',
      'index.html',
      0,
      bytes.toString('base64'),
      sha256Hex(bytes)
    )
  })

  it('makes abort idempotent and prevents writes outside a stage', async () => {
    const manifest = createManifest()
    const native = createNativeApi(manifest.buildId)
    const stager = new MobileWebNativeStagingAdapter(native, 'paired-public-key')

    await expect(stager.writeAssetChunk(manifest.assets[0]!, 0, Buffer.from('x'))).rejects.toThrow(
      'mobile_web_stage_not_started'
    )
    await stager.begin(manifest)
    await stager.abort()
    await stager.abort()
    expect(native.abortStage).toHaveBeenCalledOnce()
  })
})

function createNativeApi(buildId: string) {
  return {
    beginStage: vi.fn(async () => 'stage-id'),
    writeAssetChunk: vi.fn(async () => {}),
    finishAsset: vi.fn(async () => {}),
    commitStage: vi.fn(async () => ({ buildId })),
    abortStage: vi.fn(async () => {})
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
