import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CHUNK_BYTES } from '../../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES
} from '../../../../src/shared/mobile-web-bundle/manifest-contract'

import {
  mobileWebBundleChunkRead,
  mobileWebBundleManifestRead,
  readMobileWebBundleErrorCode
} from './mobile-web-bundle-operations'

import { MobileWebBundleManifestReadSchema } from './mobile-web-bundle-reply-schemas'
import type { RpcReadResult } from '../rpc-operation-contract'

const ASSET_SHA = 'b'.repeat(64)
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4 + 8

function asset(overrides: Record<string, unknown> = {}) {
  return {
    path: 'index.html',
    sha256: ASSET_SHA,
    byteLength: 12,
    contentType: 'text/html; charset=utf-8',
    ...overrides
  }
}

// Derive ids after fixture asset edits unless the test explicitly selects its own buildId.
function contentIdOf(assets: ReturnType<typeof asset>[]): string {
  return computeMobileWebBundleId(assets)
}

const BUILD_ID = contentIdOf([asset()])

function manifestReply(overrides: Record<string, unknown> = {}) {
  const manifest = {
    schemaVersion: 1,
    desktopVersion: '1.4.200',
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 2,
    pageVersion: 1,
    entrypoint: 'index.html',
    totalBytes: 12,
    assets: [asset()],
    ...overrides
  }
  return {
    manifest: { buildId: contentIdOf(manifest.assets), ...manifest },
    chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES
  }
}

function chunkReply(overrides: Record<string, unknown> = {}) {
  return {
    buildId: BUILD_ID,
    path: 'index.html',
    offset: 0,
    assetByteLength: 12,
    sha256: ASSET_SHA,
    dataBase64: 'aGVsbG8=',
    eof: true,
    ...overrides
  }
}

function readManifest(raw: unknown): RpcReadResult<string, unknown> {
  return mobileWebBundleManifestRead.read(raw)
}

function readChunk(raw: unknown): RpcReadResult<string, unknown> {
  return mobileWebBundleChunkRead.read(raw)
}

describe('mobile web bundle manifest reply reader', () => {
  it('refuses a manifest whose build id is not the digest of the assets it names', () => {
    // Recompute content ids because cached generations trust them to identify existing bytes.
    const forged = { ...manifestReply().manifest, buildId: 'f'.repeat(64) }

    const parsed = MobileWebBundleManifestReadSchema.safeParse(forged)

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['buildId']])
    expect(readManifest({ ...manifestReply(), manifest: forged }).compatible).toBe(false)
  })

  it('bounds what a manifest can make the fetch allocate, however it declares totalBytes', () => {
    // Bound summed allocations separately; per-asset/count/declared-total ceilings do not bound their product.
    const oversized = Array.from({ length: MOBILE_WEB_BUNDLE_MAX_ASSETS }, (_, index) =>
      asset({ path: `assets/${index}.js`, byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES })
    )
    expect(readManifest(manifestReply({ totalBytes: 0, assets: oversized })).compatible).toBe(false)
    expect(readManifest(manifestReply({ totalBytes: 12, assets: oversized })).compatible).toBe(
      false
    )
  })

  it('accepts a bundle that sums to the ceiling and refuses one byte more', () => {
    // Use four assets to fit under individual ceilings while reaching the summed allocation boundary.
    const quarter = MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES / 4
    const spread = (lastByteLength: number) =>
      Array.from({ length: 4 }, (_, index) =>
        asset({ path: `assets/${index}.js`, byteLength: index === 3 ? lastByteLength : quarter })
      )
    expect(
      readManifest(
        manifestReply({ totalBytes: MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES, assets: spread(quarter) })
      ).compatible
    ).toBe(true)
    expect(
      readManifest(
        manifestReply({
          totalBytes: MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES,
          assets: spread(quarter + 1)
        })
      ).compatible
    ).toBe(false)
  })

  it('bounds every asset field and rejects a path that could leave the bundle root', () => {
    for (const path of ['../evil.js', '/abs.js', 'a\\b.js', 'nul.js', 'trailing.']) {
      expect(readManifest(manifestReply({ assets: [asset({ path })] })).compatible).toBe(false)
    }
    expect(readManifest(manifestReply({ assets: [asset({ sha256: 'zz' })] })).compatible).toBe(
      false
    )
    expect(
      readManifest(
        manifestReply({ assets: [asset({ byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES + 1 })] })
      ).compatible
    ).toBe(false)
    expect(readManifest(manifestReply({ assets: [asset({ byteLength: -1 })] })).compatible).toBe(
      false
    )
    expect(readManifest(manifestReply({ assets: [asset({ contentType: '' })] })).compatible).toBe(
      false
    )
  })
})

describe('mobile web bundle chunk reply reader', () => {
  it('bounds dataBase64 at the chunk size the contract allows', () => {
    expect(
      readChunk(chunkReply({ dataBase64: 'A'.repeat(MAX_DATA_BASE64_LENGTH) })).compatible
    ).toBe(true)
    expect(
      readChunk(chunkReply({ dataBase64: 'A'.repeat(MAX_DATA_BASE64_LENGTH + 1) })).compatible
    ).toBe(false)
  })
})

describe('mobile web bundle error codes', () => {
  it('does not read a code a host merely quoted somewhere in its prose', () => {
    expect(
      readMobileWebBundleErrorCode(
        new Error('invalid_argument: the bundle is mobile_web_bundle_unavailable here')
      )
    ).toBeNull()
    // Quoted codes are diagnostic prose, not machine refusals.
    expect(
      readMobileWebBundleErrorCode(new Error('RPC mobile_web_bundle_unavailable failed'))
    ).toBeNull()
    // Recognize only the exact envelope-code prefix, not an arbitrary leading token.
    expect(
      readMobileWebBundleErrorCode(new Error('rpc (mobile_web_bundle_unavailable)'))
    ).toBeNull()
  })
})
