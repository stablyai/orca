import '../unused-default-rpc-methods.test-fixture'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  MobileWebBundleChunkResultSchema,
  MobileWebBundleManifestResultSchema
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcRequest, RpcResponse } from '../core'
import { ORCAD_MOBILE_WEB_DIR, ORCAD_MOBILE_WEB_MANIFEST } from '../../../../shared/orcad-artifacts'
import type { RpcDispatcher } from '../dispatcher'

import {
  getBundledMobileWebBundleRoot,
  resetBundledMobileWebBundleCacheForTests
} from '../../bundled-mobile-web-bundle'
import {
  fillMobileWebBundleReadWindow,
  resetMobileWebBundleAssetVerdictsForTests
} from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS,
  mobileWebBundleReadBucketCountForTests,
  resetMobileWebBundleReadAdmissionForTests
} from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  mobileWebBundleFiller,
  sha256Hex,
  writeSyntheticMobileWebBundle,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let dispatcher: RpcDispatcher

function request(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'tok', method, params }
}

type DispatchOptions = { connectionId?: string; clientId?: string; signal?: AbortSignal }

async function call(method: string, params?: unknown, options?: DispatchOptions) {
  return dispatcher.dispatch(request(method, params), options)
}

function errorMessage(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.message
}

async function chunk(params: unknown, options?: DispatchOptions) {
  return call('mobileWeb.bundle.chunk', params, options)
}

/** Pages one asset to the end the way a client must: never assuming a size it did not read. */
async function download(buildId: string, path: string): Promise<{ bytes: Buffer; calls: number }> {
  const pieces: Buffer[] = []
  let offset = 0
  let calls = 0
  for (;;) {
    const response = await chunk({ buildId, path, offset })
    calls++
    if (!response.ok) {
      throw new Error(`chunk at ${String(offset)} failed: ${response.error.message}`)
    }
    const body = MobileWebBundleChunkResultSchema.parse(response.result)
    expect(body.buildId).toBe(buildId)
    expect(body.path).toBe(path)
    expect(body.offset).toBe(offset)
    pieces.push(Buffer.from(body.dataBase64, 'base64'))
    if (body.eof) {
      expect(offset + pieces.at(-1)!.byteLength).toBe(body.assetByteLength)
      break
    }
    offset += MOBILE_WEB_BUNDLE_CHUNK_BYTES
  }
  return { bytes: Buffer.concat(pieces), calls }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-'))
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

describe('an install that carries a mobile web bundle', () => {
  let bundle: SyntheticMobileWebBundle

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1)
  })

  it('answers the manifest with the chunk size it will actually serve', async () => {
    const response = await call('mobileWeb.bundle.manifest')

    expect(response.ok).toBe(true)
    const body = MobileWebBundleManifestResultSchema.parse(
      response.ok ? response.result : undefined
    )
    expect(body.chunkBytes).toBe(MOBILE_WEB_BUNDLE_CHUNK_BYTES)
    expect(body.manifest.buildId).toBe(bundle.buildId)
    expect(body.manifest.assets).toEqual(bundle.assets)
  })

  // Cache manifest parsing and buildId hashing rather than repeat event-loop work per chunk.
  it('answers from the manifest it already read, without going back to disk', async () => {
    const first = await call('mobileWeb.bundle.manifest')
    writeFileSync(join(bundle.root, 'manifest.json'), 'not json', 'utf8')

    const second = await call('mobileWeb.bundle.manifest')

    expect(errorMessage(second)).toBeUndefined()
    expect(MobileWebBundleManifestResultSchema.parse(second.ok && second.result).manifest).toEqual(
      MobileWebBundleManifestResultSchema.parse(first.ok && first.result).manifest
    )
  })

  it('pages every asset back byte for byte, and each reassembly matches its manifest hash', async () => {
    for (const asset of bundle.assets) {
      const { bytes, calls } = await download(bundle.buildId, asset.path)

      expect(bytes.byteLength).toBe(asset.byteLength)
      expect(sha256Hex(bytes)).toBe(asset.sha256)
      expect(calls).toBe(Math.max(1, Math.ceil(asset.byteLength / MOBILE_WEB_BUNDLE_CHUNK_BYTES)))
    }
  })

  it('reports eof only on the last chunk of a multi-chunk asset', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect(script.byteLength).toBeGreaterThan(MOBILE_WEB_BUNDLE_CHUNK_BYTES * 2)

    const eofs: boolean[] = []
    for (let offset = 0; offset < script.byteLength; offset += MOBILE_WEB_BUNDLE_CHUNK_BYTES) {
      const response = await chunk({ buildId: bundle.buildId, path: script.path, offset })
      expect(response.ok).toBe(true)
      eofs.push(MobileWebBundleChunkResultSchema.parse(response.ok && response.result).eof)
    }

    expect(eofs).toEqual([false, false, true])
  })

  // Exact chunk multiples must report EOF now; the next offset is invalid.
  it('ends an exactly-one-chunk asset on its first chunk', async () => {
    const stylesheet = bundle.assets.find((asset) => asset.path.endsWith('.css'))!
    expect(stylesheet.byteLength).toBe(MOBILE_WEB_BUNDLE_CHUNK_BYTES)

    const first = await chunk({ buildId: bundle.buildId, path: stylesheet.path, offset: 0 })
    const past = await chunk({
      buildId: bundle.buildId,
      path: stylesheet.path,
      offset: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })

    expect(MobileWebBundleChunkResultSchema.parse(first.ok && first.result).eof).toBe(true)
    expect(errorMessage(past)).toBe('mobile_web_bundle_offset_invalid')
  })

  // Allow offset zero for empty assets so clients can fetch every manifest member.
  it('serves a zero-byte asset as one empty chunk at eof', async () => {
    const mark = bundle.assets.find((asset) => asset.byteLength === 0)!

    const response = await chunk({ buildId: bundle.buildId, path: mark.path, offset: 0 })

    const body = MobileWebBundleChunkResultSchema.parse(response.ok && response.result)
    expect(body).toMatchObject({ dataBase64: '', eof: true, assetByteLength: 0 })
  })

  it('describes the whole asset on every chunk, not the chunk', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!

    const middle = await chunk({
      buildId: bundle.buildId,
      path: script.path,
      offset: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })

    const body = MobileWebBundleChunkResultSchema.parse(middle.ok && middle.result)
    expect(body.assetByteLength).toBe(script.byteLength)
    expect(body.sha256).toBe(script.sha256)
    expect(Buffer.from(body.dataBase64, 'base64').byteLength).toBe(MOBILE_WEB_BUNDLE_CHUNK_BYTES)
  })

  it('rejects a traversal path at the params schema, before any lookup', async () => {
    const response = await chunk({ buildId: bundle.buildId, path: '../../etc/passwd', offset: 0 })

    expect(response.ok).toBe(false)
    expect(errorMessage(response)).not.toBe('mobile_web_bundle_asset_unknown')
  })

  // After auto-update, report build-changed before path lookup so clients restart from the manifest.
  it('refuses the old buildId after the install swaps bundles mid-download', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)

    rmSync(join(scratch, 'out', 'mobile-web'), { recursive: true, force: true })
    const replacement = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 2)
    resetBundledMobileWebBundleCacheForTests()
    expect(replacement.buildId).not.toBe(bundle.buildId)

    const stale = await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })

    expect(errorMessage(stale)).toBe('mobile_web_bundle_build_changed')
  })

  // A path survives rebuild; key verdicts by build too so an old failure cannot poison new bytes.
  it('does not carry a failed verdict from one build onto the next build of the same path', async () => {
    writeFileSync(join(bundle.root, 'index.html'), mobileWebBundleFiller(640, 99))
    expect(
      errorMessage(await chunk({ buildId: bundle.buildId, path: 'index.html', offset: 0 }))
    ).toBe('mobile_web_bundle_asset_changed')

    rmSync(join(scratch, 'out', 'mobile-web'), { recursive: true, force: true })
    const replacement = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 8)
    resetBundledMobileWebBundleCacheForTests()

    const response = await chunk({ buildId: replacement.buildId, path: 'index.html', offset: 0 })

    expect(errorMessage(response)).toBeUndefined()
  })

  // Map post-verification filesystem failure to a contract code without exposing the host install path.
  it('answers a changed asset, not the filesystem error, when the asset is gone after its verdict', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)
    unlinkSync(join(bundle.root, script.path))

    const response = await chunk({
      buildId: bundle.buildId,
      path: script.path,
      offset: MOBILE_WEB_BUNDLE_CHUNK_BYTES
    })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
    expect(console.warn).toHaveBeenCalled()
  })

  // Truncation after verification must not return a short chunk and let clients page past missing bytes.
  it('answers a changed asset when the file is shorter than the manifest promised', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)
    truncateSync(join(bundle.root, script.path), 100)

    const response = await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
  })

  // Packaged assets are immutable; one cached hash per asset is enough, and dev byte restoration requires restart.
  it('remembers the verdict, so one hash per asset covers every later chunk', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    const corrupted = mobileWebBundleFiller(script.byteLength, 99)
    writeFileSync(join(bundle.root, script.path), corrupted)
    expect(
      errorMessage(await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 }))
    ).toBe('mobile_web_bundle_asset_changed')

    writeFileSync(join(bundle.root, script.path), mobileWebBundleFiller(script.byteLength, 1))

    expect(
      errorMessage(await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 }))
    ).toBe('mobile_web_bundle_asset_changed')
    resetMobileWebBundleAssetVerdictsForTests()
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)
  })

  // Plain-WebSocket buckets may hold pairing tokens; drop empty buckets during mobile reconnect churn.
  it('keeps no bucket for a connection that finished its reads', () => {
    for (let socket = 0; socket < 50; socket++) {
      const release = acquireMobileWebBundleReadSlot(`device-token-${String(socket)}`)
      expect(release).not.toBeNull()
      release?.()
    }

    expect(mobileWebBundleReadBucketCountForTests()).toBe(0)
  })

  it('stops before reading anything for a client that already disconnected', async () => {
    const controller = new AbortController()
    controller.abort()

    const response = await chunk(
      { buildId: bundle.buildId, path: 'index.html', offset: 0 },
      {
        signal: controller.signal
      }
    )

    expect(response.ok).toBe(false)
    expect(errorMessage(response)).toBe('client_disconnected')
  })

  it('gives the slot back after an abort, so the cap does not leak', async () => {
    const controller = new AbortController()
    controller.abort()
    await chunk(
      { buildId: bundle.buildId, path: 'index.html', offset: 0 },
      {
        connectionId: 'conn-c',
        signal: controller.signal
      }
    )

    const held = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      acquireMobileWebBundleReadSlot('conn-c')
    )

    expect(held.every((release) => release !== null)).toBe(true)
  })
})

describe('where the resolver probes', () => {
  it('finds out/mobile-web under the install root', () => {
    const bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 5)

    expect(getBundledMobileWebBundleRoot()).toBe(bundle.root)
  })

  it('finds the page an orcad slot ships, without a resolver of its own', () => {
    const bundle = writeSyntheticMobileWebBundle(
      join(scratch, ...ORCAD_MOBILE_WEB_DIR.split('/')),
      2
    )

    expect(getBundledMobileWebBundleRoot()).toBe(bundle.root)
    expect(join(bundle.root, 'manifest.json')).toBe(
      join(scratch, ...ORCAD_MOBILE_WEB_MANIFEST.split('/'))
    )
  })

  it('answers undefined when neither layout holds a manifest', () => {
    expect(getBundledMobileWebBundleRoot()).toBeUndefined()
  })

  it('finds the bundle beside an out/main app path', async () => {
    const bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 3)
    installMobileWebBundleAppPath(join(scratch, 'out', 'main'))
    resetBundledMobileWebBundleCacheForTests()

    const response = await call('mobileWeb.bundle.manifest')

    expect(
      MobileWebBundleManifestResultSchema.parse(response.ok && response.result).manifest.buildId
    ).toBe(bundle.buildId)
  })
})

describe('an install with no mobile web bundle', () => {
  it('reports both methods unavailable rather than failing some other way', async () => {
    const manifest = await call('mobileWeb.bundle.manifest')
    const body = await chunk({ buildId: '0'.repeat(64), path: 'index.html', offset: 0 })

    expect(errorMessage(manifest)).toBe('mobile_web_bundle_unavailable')
    expect(errorMessage(body)).toBe('mobile_web_bundle_unavailable')
  })

  it('reads a manifest that does not match the contract as no bundle at all', async () => {
    const root = join(scratch, 'out', 'mobile-web')
    writeSyntheticMobileWebBundle(root, 4)
    writeFileSync(join(root, 'manifest.json'), '{"schemaVersion":2}', 'utf8')
    resetBundledMobileWebBundleCacheForTests()

    const response = await call('mobileWeb.bundle.manifest')

    expect(errorMessage(response)).toBe('mobile_web_bundle_unavailable')
    expect(console.warn).toHaveBeenCalled()
  })

  it('reads an unparseable manifest as no bundle at all', async () => {
    const root = join(scratch, 'out', 'mobile-web')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'manifest.json'), 'not json', 'utf8')
    resetBundledMobileWebBundleCacheForTests()

    expect(errorMessage(await call('mobileWeb.bundle.manifest'))).toBe(
      'mobile_web_bundle_unavailable'
    )
  })
})

// Registry presence does not prove mobile authorization; used-subset checks miss methods before a client uses them.
describe('mobile authorization', () => {
  it('lets a paired phone call both bundle methods', () => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(MOBILE_WEB_BUNDLE_MANIFEST_METHOD)).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(MOBILE_WEB_BUNDLE_CHUNK_METHOD)).toBe(true)
  })
})

// Regular-file reads may split before EOF; fill the window before returning a chunk.
describe('filling a read window', () => {
  const source = mobileWebBundleFiller(64, 3)

  /** Answers `pieces[n]` bytes to the nth read, so a split window can be driven exactly. */
  function reader(pieces: number[]) {
    const calls: number[] = []
    let piece = 0
    const read = async (buffer: Buffer, into: number, length: number, position: number) => {
      calls.push(length)
      const bytesRead = Math.min(pieces[piece++] ?? 0, length)
      source.copy(buffer, into, position, position + bytesRead)
      return { bytesRead }
    }
    return { calls, read }
  }

  it('reads again when a read answers short of the window', async () => {
    const buffer = Buffer.alloc(64)
    const stub = reader([24, 40])

    const filled = await fillMobileWebBundleReadWindow(stub, buffer, 64, 0)

    expect(filled).toBe(64)
    expect(stub.calls).toEqual([64, 40])
    expect(buffer.equals(source)).toBe(true)
  })

  it('stops at the read that returns nothing, which is the truncation the caller reports', async () => {
    const stub = reader([24, 0])

    const filled = await fillMobileWebBundleReadWindow(stub, Buffer.alloc(64), 64, 0)

    expect(filled).toBe(24)
  })
})
