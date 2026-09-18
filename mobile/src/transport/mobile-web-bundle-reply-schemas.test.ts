import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_ERROR_CODES
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  MOBILE_WEB_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import { evaluateMobileWebBundleCompat } from './mobile-web-bundle-compat'
import {
  isMobileWebBundleTransportFailure,
  mobileWebBundleChunkRead,
  mobileWebBundleManifestRead,
  readMobileWebBundleErrorCode
} from './mobile-web-bundle-operations'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { MobileWebBundleManifestReplySchema } from './mobile-web-bundle-reply-schemas'
import type { RpcReadResult } from './rpc-operation-contract'

const BUILD_ID = 'a'.repeat(64)
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

function manifestReply(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      schemaVersion: 1,
      buildId: BUILD_ID,
      desktopVersion: '1.4.200',
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes: 12,
      assets: [asset()],
      ...overrides
    },
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
  it('reads a manifest and keeps every member an unknown key carries', () => {
    const result = readManifest({
      ...manifestReply(),
      manifest: { ...manifestReply().manifest, contentEncoding: 'br' },
      servedFrom: 'asar'
    })

    expect(result.compatible).toBe(true)
    if (!result.compatible) {
      return
    }
    expect(result.variant).toBe('mobile-web-bundle-manifest')
    expect(result.salvage).toEqual({ droppedPaths: [], droppedCount: 0 })
    expect(result.value).toMatchObject({
      servedFrom: 'asar',
      chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES,
      manifest: { contentEncoding: 'br', buildId: BUILD_ID }
    })
  })

  it('accepts a host that shrank chunkBytes and refuses one that grew it', () => {
    expect(readManifest({ ...manifestReply(), chunkBytes: 1 }).compatible).toBe(true)
    expect(
      readManifest({ ...manifestReply(), chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES }).compatible
    ).toBe(true)
    for (const chunkBytes of [0, -1, 1.5, MOBILE_WEB_BUNDLE_CHUNK_BYTES + 1]) {
      expect(readManifest({ ...manifestReply(), chunkBytes }).compatible).toBe(false)
    }
  })

  it('bounds what a manifest can make the fetch allocate, however it declares totalBytes', () => {
    // The ceilings above bound each asset and the asset count, and `totalBytes` separately. None
    // of them bounds the product, which is what the fetch allocates.
    const oversized = Array.from({ length: MOBILE_WEB_BUNDLE_MAX_ASSETS }, (_, index) =>
      asset({ path: `assets/${index}.js`, byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES })
    )
    expect(readManifest(manifestReply({ totalBytes: 0, assets: oversized })).compatible).toBe(false)
    expect(readManifest(manifestReply({ totalBytes: 12, assets: oversized })).compatible).toBe(
      false
    )
  })

  it('accepts a bundle that sums to the ceiling and refuses one byte more', () => {
    // Four assets, because one quarter of the total ceiling is the largest share that still fits
    // under the per-asset ceiling. `lastByteLength` moves only the final one.
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

  it('refuses one asset over the per-asset ceiling and accepts one at it', () => {
    expect(
      readManifest(
        manifestReply({
          totalBytes: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
          assets: [asset({ byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES })]
        })
      ).compatible
    ).toBe(true)
    expect(
      readManifest(
        manifestReply({ assets: [asset({ byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES + 1 })] })
      ).compatible
    ).toBe(false)
  })

  it('reads an unknown schemaVersion through so the update wall can name it', () => {
    // Refusing it here would fail the parse before `evaluateMobileWebBundleCompat` could say
    // `bundle-shell-too-old`, leaving a transport error where the wall belongs.
    expect(readManifest(manifestReply({ schemaVersion: 2 })).compatible).toBe(true)
    expect(readManifest(manifestReply({ schemaVersion: undefined })).compatible).toBe(false)
    for (const schemaVersion of [1.5, 'one', null]) {
      expect(readManifest(manifestReply({ schemaVersion })).compatible).toBe(false)
    }
  })

  it('types the protocol window the update wall compares, without a cast at the call site', () => {
    const parsed = MobileWebBundleManifestReplySchema.parse(manifestReply())
    // The pin is this call: `manifest` only assigns if the reader still types both window fields.
    const verdict = evaluateMobileWebBundleCompat({
      hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
      hostStatus: { protocolVersion: 2, minCompatibleMobileVersion: 2 },
      manifest: parsed.manifest
    })

    expect(verdict).toEqual({ kind: 'ok', manifestChecked: true })
  })

  it('refuses a manifest with no protocol window, which only a host without the capability sends', () => {
    expect(readManifest(manifestReply({ runtimeProtocolVersion: undefined })).compatible).toBe(
      false
    )
    expect(
      readManifest(manifestReply({ minCompatibleRuntimeProtocolVersion: undefined })).compatible
    ).toBe(false)
    expect(readManifest(manifestReply({ runtimeProtocolVersion: -1 })).compatible).toBe(false)
  })

  it('bounds every manifest field the fetch reads', () => {
    expect(readManifest(manifestReply({ buildId: 'A'.repeat(64) })).compatible).toBe(false)
    expect(readManifest(manifestReply({ buildId: 'a'.repeat(63) })).compatible).toBe(false)
    expect(readManifest(manifestReply({ assets: [] })).compatible).toBe(false)
    expect(
      readManifest(
        manifestReply({
          assets: Array.from({ length: MOBILE_WEB_BUNDLE_MAX_ASSETS + 1 }, (_, index) =>
            asset({ path: `assets/${index}.js` })
          )
        })
      ).compatible
    ).toBe(false)
    expect(
      readManifest(manifestReply({ totalBytes: MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES + 1 })).compatible
    ).toBe(false)
    expect(readManifest(manifestReply({ entrypoint: undefined })).compatible).toBe(false)
    expect(readManifest(manifestReply({ entrypoint: '../escape.html' })).compatible).toBe(false)
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
  it('reads a chunk and passes an unknown member through', () => {
    const result = readChunk({ ...chunkReply(), contentEncoding: 'br' })

    expect(result.compatible).toBe(true)
    if (!result.compatible) {
      return
    }
    expect(result.variant).toBe('mobile-web-bundle-chunk')
    expect(result.value).toMatchObject({ contentEncoding: 'br', eof: true, offset: 0 })
    expect(result.salvage.droppedCount).toBe(0)
  })

  it('bounds dataBase64 at the chunk size the contract allows', () => {
    expect(
      readChunk(chunkReply({ dataBase64: 'A'.repeat(MAX_DATA_BASE64_LENGTH) })).compatible
    ).toBe(true)
    expect(
      readChunk(chunkReply({ dataBase64: 'A'.repeat(MAX_DATA_BASE64_LENGTH + 1) })).compatible
    ).toBe(false)
  })

  it('requires every member that makes a chunk self-describing', () => {
    for (const overrides of [
      { buildId: 'nope' },
      { path: '../escape.js' },
      { offset: -1 },
      { offset: 1.5 },
      { assetByteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES + 1 },
      { sha256: 'b'.repeat(63) },
      { dataBase64: undefined },
      { eof: 'yes' },
      { eof: undefined }
    ]) {
      expect(readChunk(chunkReply(overrides)).compatible).toBe(false)
    }
  })

  it('refuses a reply that is not an object at all', () => {
    for (const raw of [null, undefined, 'chunk', 7, []]) {
      expect(readChunk(raw).compatible).toBe(false)
    }
  })
})

describe('mobile web bundle error codes', () => {
  it('maps every code the host declares, from both positions one can occupy', () => {
    expect(MOBILE_WEB_BUNDLE_ERROR_CODES).toHaveLength(6)
    for (const code of MOBILE_WEB_BUNDLE_ERROR_CODES) {
      expect(readMobileWebBundleErrorCode(new Error(`invalid_argument: ${code}`))).toBe(code)
      expect(readMobileWebBundleErrorCode(new Error(code))).toBe(code)
      expect(readMobileWebBundleErrorCode(new Error(`invalid_argument: ${code}: no bundle`))).toBe(
        code
      )
    }
  })

  it('answers null for anything that is not one of those six', () => {
    expect(readMobileWebBundleErrorCode(new Error('invalid_argument: some_other_code'))).toBeNull()
    expect(readMobileWebBundleErrorCode(new Error('internal_error: boom'))).toBeNull()
    expect(readMobileWebBundleErrorCode(new Error(' '))).toBeNull()
    expect(readMobileWebBundleErrorCode(new Error('Network request failed'))).toBeNull()
    expect(readMobileWebBundleErrorCode('mobile_web_bundle_unavailable')).toBeNull()
    expect(readMobileWebBundleErrorCode(null)).toBeNull()
  })

  it('does not read a code a host merely quoted somewhere in its prose', () => {
    expect(
      readMobileWebBundleErrorCode(
        new Error('invalid_argument: the bundle is mobile_web_bundle_unavailable here')
      )
    ).toBeNull()
    // Unanchored, this one reads as a refusal; the code is neither the whole message nor what
    // follows the envelope code.
    expect(
      readMobileWebBundleErrorCode(new Error('RPC mobile_web_bundle_unavailable failed'))
    ).toBeNull()
    // The second position is `<envelope code>: `, exactly. Slicing the leading token's length off
    // any message would make this one read as the code that follows the bracket.
    expect(
      readMobileWebBundleErrorCode(new Error('rpc (mobile_web_bundle_unavailable)'))
    ).toBeNull()
  })

  it('reads a dispatcher schema refusal, whose message is prose, as no code at all', () => {
    for (const message of [
      'invalid_argument: Invalid input: expected string, received number',
      'invalid_argument: too_small: expected string to have >=1 characters'
    ]) {
      expect(readMobileWebBundleErrorCode(new Error(message))).toBeNull()
    }
  })
})

describe('mobile web bundle operation descriptors', () => {
  it('accepts no reply but a result', () => {
    // A salvage or bare-message policy would hand the fetch a half-bundle that fails a hash check
    // much later, far from the cause.
    for (const operation of [mobileWebBundleManifestRead, mobileWebBundleChunkRead]) {
      expect(operation.acceptance).toBe('require-result-or-throw')
      expect(operation.barrier).toBe('on-settle')
    }
  })
})

describe('which side a bundle read failed on', () => {
  it('reads the transport marks the transport itself sets', () => {
    // Every socket close, relay drop and request timeout rejects in-flight requests with this mark.
    expect(
      isMobileWebBundleTransportFailure(markRpcDeliveryUnknown(new Error('Connection closed')))
    ).toBe(true)
    // The cutover error matches by message as well as by class, across bundle copies.
    expect(
      isMobileWebBundleTransportFailure(new Error('RPC interrupted by connection migration'))
    ).toBe(true)
  })

  it.each([
    ['a host refusal', `invalid_argument: ${MOBILE_WEB_BUNDLE_ERROR_CODES[0]}`],
    ['bytes that do not hash', 'bundle asset index.html hashed aa, not bb'],
    ['a build that changed mid-fetch', 'bundle build changed mid-fetch: asked aa, served bb'],
    ['an unread reply', 'The host sent a reply this app could not read (mobileWeb.bundle.manifest)']
  ])('treats %s as a verdict about the bundle', (_label, message) => {
    expect(isMobileWebBundleTransportFailure(new Error(message))).toBe(false)
  })

  it('treats anything that is not an error as a verdict too, rather than guessing', () => {
    expect(isMobileWebBundleTransportFailure('Connection closed')).toBe(false)
    expect(isMobileWebBundleTransportFailure(null)).toBe(false)
  })
})
