import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleManifestResultSchema,
  MobileWebBundleRangeResultSchema,
  type MobileWebBundleRangeResult
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import { resetBundledMobileWebBundleCacheForTests } from '../../bundled-mobile-web-bundle'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcResponse } from '../core'
import type { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
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
  const bytes = mobileWebBundleFiller(MOBILE_WEB_BUNDLE_RANGE_BYTES * 2 + 777, 11)
  return { path: `assets/${sha256Hex(bytes)}.js`, bytes, contentType: 'text/javascript' }
})()
const INCOMPRESSIBLE: SyntheticAsset = (() => {
  const bytes = randomBytes(MOBILE_WEB_BUNDLE_RANGE_BYTES + 4096)
  return { path: `assets/${sha256Hex(bytes)}.bin`, bytes, contentType: 'application/octet-stream' }
})()

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-range-'))
  installMobileWebBundleAppPath(scratch)
  resetBundledMobileWebBundleCacheForTests()
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

  it('names the range grid on the manifest reply', async () => {
    const response = await call('mobileWeb.bundle.manifest')
    const result = MobileWebBundleManifestResultSchema.parse(response.ok && response.result)
    expect(result.rangeBytes).toBe(MOBILE_WEB_BUNDLE_RANGE_BYTES)
  })

  // The manifest field is the phone's only discovery, and a mobile-scoped call to a method this
  // build does not allowlist answers `forbidden`: the promise is honest only if both hold.
  it('names the grid only for a method a paired phone can actually call', async () => {
    const response = await call('mobileWeb.bundle.manifest')
    expect(
      MobileWebBundleManifestResultSchema.parse(response.ok && response.result).rangeBytes
    ).toBeDefined()
    expect(ALL_RPC_METHODS.map((method) => method.name)).toContain(MOBILE_WEB_BUNDLE_RANGE_METHOD)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(MOBILE_WEB_BUNDLE_RANGE_METHOD)).toBe(true)
  })

  it('pages every asset back byte for byte on the range grid, each reply a strict result', async () => {
    for (const asset of bundle.assets) {
      const pieces: Buffer[] = []
      let calls = 0
      for (let offset = 0; ; offset += MOBILE_WEB_BUNDLE_RANGE_BYTES) {
        const result = body(await range({ buildId: bundle.buildId, path: asset.path, offset }))
        calls++
        expect(result).toMatchObject({
          buildId: bundle.buildId,
          path: asset.path,
          offset,
          assetByteLength: asset.byteLength,
          sha256: asset.sha256
        })
        pieces.push(decoded(result))
        if (result.eof) {
          break
        }
      }
      expect(sha256Hex(Buffer.concat(pieces))).toBe(asset.sha256)
      expect(calls).toBe(Math.max(1, Math.ceil(asset.byteLength / MOBILE_WEB_BUNDLE_RANGE_BYTES)))
    }
  })

  it('gzips a compressible range, and the gzip decodes to exactly that range', async () => {
    const result = body(
      await range({
        buildId: bundle.buildId,
        path: COMPRESSIBLE.path,
        offset: MOBILE_WEB_BUNDLE_RANGE_BYTES
      })
    )

    expect(result.encoding).toBe('gzip')
    expect(Buffer.from(result.dataBase64, 'base64').byteLength).toBeLessThan(
      MOBILE_WEB_BUNDLE_RANGE_BYTES / 10
    )
    expect(
      decoded(result).equals(
        COMPRESSIBLE.bytes.subarray(
          MOBILE_WEB_BUNDLE_RANGE_BYTES,
          MOBILE_WEB_BUNDLE_RANGE_BYTES * 2
        )
      )
    ).toBe(true)
    expect(result.eof).toBe(false)
  })

  // Gzip framing adds bytes to data that does not compress; identity keeps the frame bound.
  it('sends identity for a range gzip would not shrink', async () => {
    const result = body(
      await range({ buildId: bundle.buildId, path: INCOMPRESSIBLE.path, offset: 0 })
    )

    expect(result.encoding).toBe('identity')
    expect(
      Buffer.from(result.dataBase64, 'base64').equals(
        INCOMPRESSIBLE.bytes.subarray(0, MOBILE_WEB_BUNDLE_RANGE_BYTES)
      )
    ).toBe(true)
  })

  it('serves a zero-byte asset as one empty identity range at eof', async () => {
    const mark = bundle.assets.find((asset) => asset.byteLength === 0)!

    const result = body(await range({ buildId: bundle.buildId, path: mark.path, offset: 0 }))

    expect(result).toMatchObject({ encoding: 'identity', dataBase64: '', eof: true })
  })

  it('refuses a caller-chosen length at the params schema', async () => {
    const response = await range({
      buildId: bundle.buildId,
      path: COMPRESSIBLE.path,
      offset: 0,
      length: 1000
    })

    expect(response.ok ? undefined : response.error.code).toBe('invalid_argument')
  })
})
