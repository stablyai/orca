import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_BROTLI_RANGE_METHOD,
  MOBILE_WEB_BUNDLE_CHUNK_BYTES as RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleBrotliRangeResultSchema,
  MobileWebBundleRangeResultSchema,
  type MobileWebBundleRangeResult
} from '../../../../../shared/mobile-web-bundle/bundle-rpc-contract'

import type { RpcResponse } from '../../core'
import type { RpcDispatcher } from '../../dispatcher'

import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import { resetMobileWebBundleReadAdmissionForTests } from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  mobileWebBundleFiller,
  sha256Hex,
  writeSyntheticMobileWebBundle,
  type SyntheticAsset,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let dispatcher: RpcDispatcher

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return dispatcher.dispatch({ id: 'req', authToken: 'tok', method, params })
}

function range(params: unknown): Promise<RpcResponse> {
  return call(MOBILE_WEB_BUNDLE_RANGE_METHOD, params)
}

function body(response: RpcResponse): MobileWebBundleRangeResult {
  if (!response.ok) {
    throw new Error(`range failed: ${response.error.message}`)
  }
  return MobileWebBundleRangeResultSchema.parse(response.result)
}

function decoded(result: MobileWebBundleRangeResult): Buffer {
  const wire = Buffer.from(result.dataBase64, 'base64')
  return result.encoding === 'gzip' ? gunzipSync(wire) : wire
}

// Period-256 filler compresses by two orders of magnitude; random bytes do not compress at all.
const COMPRESSIBLE: SyntheticAsset = (() => {
  const bytes = mobileWebBundleFiller(RANGE_BYTES * 2 + 777, 11)
  return { path: `assets/${sha256Hex(bytes)}.js`, bytes, contentType: 'text/javascript' }
})()
const INCOMPRESSIBLE: SyntheticAsset = (() => {
  const bytes = randomBytes(RANGE_BYTES + 4096)
  return { path: `assets/${sha256Hex(bytes)}.bin`, bytes, contentType: 'application/octet-stream' }
})()

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-range-'))
  installMobileWebBundleAppPath(scratch)
  resetMobileWebBundleAssetVerdictsForTests()
  resetMobileWebBundleReadAdmissionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dispatcher = mobileWebBundleDispatcher()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('mobileWeb.bundle.range on an install that carries a bundle', () => {
  let bundle: SyntheticMobileWebBundle

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1, [
      COMPRESSIBLE,
      INCOMPRESSIBLE
    ])
  })

  it('pages every asset back byte for byte on the range grid, each reply a strict result', async () => {
    for (const asset of bundle.assets) {
      const pieces: Buffer[] = []
      let calls = 0
      for (let offset = 0; ; offset += RANGE_BYTES) {
        const result = body(await range({ buildId: bundle.buildId, path: asset.path, offset }))
        calls++
        expect(result).toMatchObject({
          buildId: bundle.buildId,
          path: asset.path,
          offset,
          assetByteLength: asset.byteLength,
          sha256: asset.sha256
        })
        expect(decoded(result).byteLength).toBe(Math.min(RANGE_BYTES, asset.byteLength - offset))
        expect(result.eof).toBe(offset + RANGE_BYTES >= asset.byteLength)
        pieces.push(decoded(result))
        if (result.eof) {
          break
        }
      }
      expect(sha256Hex(Buffer.concat(pieces))).toBe(asset.sha256)
      expect(calls).toBe(Math.max(1, Math.ceil(asset.byteLength / RANGE_BYTES)))
    }
  })

  it('gzips a compressible range, and the gzip decodes to exactly that range', async () => {
    const result = body(
      await range({
        buildId: bundle.buildId,
        path: COMPRESSIBLE.path,
        offset: RANGE_BYTES
      })
    )

    expect(result.encoding).toBe('gzip')
    expect(Buffer.from(result.dataBase64, 'base64').byteLength).toBeLessThan(RANGE_BYTES / 10)
    expect(decoded(result).equals(COMPRESSIBLE.bytes.subarray(RANGE_BYTES, RANGE_BYTES * 2))).toBe(
      true
    )
    expect(result.eof).toBe(false)
  })

  it('sends identity for a range gzip would not shrink', async () => {
    const result = body(
      await range({ buildId: bundle.buildId, path: INCOMPRESSIBLE.path, offset: 0 })
    )

    expect(result.encoding).toBe('identity')
    expect(
      Buffer.from(result.dataBase64, 'base64').equals(INCOMPRESSIBLE.bytes.subarray(0, RANGE_BYTES))
    ).toBe(true)
  })
})

describe('mobileWeb.bundle.brotliRange', () => {
  // Base64 text shrinks only to about 3/4, so its copy spans several windows.
  const SCRIPT: SyntheticAsset = (() => {
    const bytes = Buffer.from(randomBytes(RANGE_BYTES * 2).toString('base64'))
    return {
      path: `assets/${sha256Hex(bytes)}.js`,
      bytes,
      contentType: 'text/javascript',
      brotli: true
    }
  })()
  let bundle: SyntheticMobileWebBundle

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1, [
      SCRIPT,
      INCOMPRESSIBLE
    ])
  })

  it('pages the brotli copy on the range grid, and the pages inflate to the asset', async () => {
    const entry = bundle.assets.find((asset) => asset.path === SCRIPT.path)
    const copyLength = entry?.brotliByteLength ?? 0
    expect(copyLength).toBeGreaterThan(0)
    const pieces: Buffer[] = []
    for (let offset = 0; ; offset += RANGE_BYTES) {
      const response = await call(MOBILE_WEB_BUNDLE_BROTLI_RANGE_METHOD, {
        buildId: bundle.buildId,
        path: SCRIPT.path,
        offset
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = MobileWebBundleBrotliRangeResultSchema.parse(response.result)
      expect(result).toMatchObject({
        path: SCRIPT.path,
        offset,
        assetByteLength: SCRIPT.bytes.byteLength,
        sha256: sha256Hex(SCRIPT.bytes),
        eof: offset + RANGE_BYTES >= copyLength
      })
      pieces.push(Buffer.from(result.dataBase64, 'base64'))
      if (result.eof) {
        break
      }
    }
    expect(pieces.length).toBe(Math.ceil(copyLength / RANGE_BYTES))
    expect(pieces.length).toBeGreaterThan(1)
    expect(Buffer.concat(pieces).byteLength).toBe(copyLength)
    expect(brotliDecompressSync(Buffer.concat(pieces)).equals(SCRIPT.bytes)).toBe(true)
  })

  it('refuses an asset the manifest gives no brotli copy', async () => {
    const response = await call(MOBILE_WEB_BUNDLE_BROTLI_RANGE_METHOD, {
      buildId: bundle.buildId,
      path: INCOMPRESSIBLE.path,
      offset: 0
    })

    expect(response.ok).toBe(false)
    expect(response.ok ? null : response.error.message).toBe('mobile_web_bundle_asset_unknown')
  })
})
