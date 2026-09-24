import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_METHOD
} from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import { resetBundledMobileWebBundleCacheForTests } from '../../bundled-mobile-web-bundle'
import type { RpcResponse } from '../core'
import type { RpcDispatcher } from '../dispatcher'
import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import {
  acquireMobileWebBundleReadSlot,
  MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS,
  resetMobileWebBundleReadAdmissionForTests
} from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  mobileWebBundleFiller,
  writeSyntheticMobileWebBundle,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let dispatcher: RpcDispatcher

type DispatchOptions = { connectionId?: string; clientId?: string }

function errorMessage(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.message
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-window-'))
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

// Both read methods run the same checks in the same order; only the grid differs.
describe.each([
  { method: MOBILE_WEB_BUNDLE_CHUNK_METHOD, grid: MOBILE_WEB_BUNDLE_CHUNK_BYTES },
  { method: MOBILE_WEB_BUNDLE_RANGE_METHOD, grid: MOBILE_WEB_BUNDLE_RANGE_BYTES }
])('$method refusals', ({ method, grid }) => {
  let bundle: SyntheticMobileWebBundle
  let script: SyntheticMobileWebBundle['assets'][number]

  const read = (params: unknown, options?: DispatchOptions): Promise<RpcResponse> =>
    dispatcher.dispatch({ id: 'req', authToken: 'tok', method, params }, options)

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1)
    script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
  })

  it('refuses a stale build before looking the path up', async () => {
    const response = await read({ buildId: '0'.repeat(64), path: 'assets/nope.js', offset: 0 })
    expect(errorMessage(response)).toBe('mobile_web_bundle_build_changed')
  })

  it('refuses a path that is not a manifest member', async () => {
    for (const path of ['assets/does-not-exist.js', 'manifest.json', 'INDEX.HTML']) {
      const response = await read({ buildId: bundle.buildId, path, offset: 0 })
      expect(errorMessage(response)).toBe('mobile_web_bundle_asset_unknown')
    }
  })

  it('refuses an offset off its grid, or an aligned one past the end', async () => {
    for (const offset of [1, grid - 1, grid + 1, grid * 3]) {
      const response = await read({ buildId: bundle.buildId, path: script.path, offset })
      expect(errorMessage(response)).toBe('mobile_web_bundle_offset_invalid')
    }
  })

  it('refuses an asset whose bytes no longer hash to the manifest', async () => {
    writeFileSync(join(bundle.root, script.path), mobileWebBundleFiller(script.byteLength, 99))
    const response = await read({ buildId: bundle.buildId, path: script.path, offset: 0 })
    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
  })

  // One budget per connection across both methods, so a phone mixing them cannot hold eight.
  it('charges the shared read slots and refuses one past the cap', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      acquireMobileWebBundleReadSlot('conn-a')
    )
    expect(held.every((release) => release !== null)).toBe(true)
    const params = { buildId: bundle.buildId, path: 'index.html', offset: 0 }

    expect(errorMessage(await read(params, { connectionId: 'conn-a' }))).toBe(
      'mobile_web_bundle_read_limited'
    )
    // One phone at its cap must not cost another phone a thing.
    expect((await read(params, { connectionId: 'conn-b' })).ok).toBe(true)
    held[0]!()
    expect((await read(params, { connectionId: 'conn-a' })).ok).toBe(true)
  })

  it('falls back to the device token when the connection has no id', async () => {
    Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      acquireMobileWebBundleReadSlot('device-token-1')
    )
    const response = await read(
      { buildId: bundle.buildId, path: 'index.html', offset: 0 },
      { clientId: 'device-token-1' }
    )
    expect(errorMessage(response)).toBe('mobile_web_bundle_read_limited')
  })

  it('answers unavailable on an install with no bundle', async () => {
    rmSync(join(scratch, 'out'), { recursive: true, force: true })
    resetBundledMobileWebBundleCacheForTests()
    const response = await read({ buildId: '0'.repeat(64), path: 'index.html', offset: 0 })
    expect(errorMessage(response)).toBe('mobile_web_bundle_unavailable')
  })
})
