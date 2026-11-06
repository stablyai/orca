import '../../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_RANGE_METHOD
} from '../../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import { resetBundledMobileWebBundleCacheForTests } from '../../../bundled-mobile-web-bundle'
import type { RpcResponse } from '../../core'
import type { RpcDispatcher } from '../../dispatcher'
import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import { resetMobileWebBundleReadAdmissionForTests } from './mobile-web-bundle-read-admission'
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

describe.each([
  { method: MOBILE_WEB_BUNDLE_CHUNK_METHOD, grid: MOBILE_WEB_BUNDLE_CHUNK_BYTES },
  { method: MOBILE_WEB_BUNDLE_RANGE_METHOD, grid: MOBILE_WEB_BUNDLE_CHUNK_BYTES }
])('$method refusals', ({ method }) => {
  let bundle: SyntheticMobileWebBundle
  let script: SyntheticMobileWebBundle['assets'][number]

  const read = (params: unknown, options?: DispatchOptions): Promise<RpcResponse> =>
    dispatcher.dispatch({ id: 'req', authToken: 'tok', method, params }, options)

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1)
    script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
  })

  it('refuses a path that is not a manifest member', async () => {
    for (const path of ['assets/does-not-exist.js', 'manifest.json', 'INDEX.HTML']) {
      const response = await read({ buildId: bundle.buildId, path, offset: 0 })
      expect(errorMessage(response)).toBe('mobile_web_bundle_asset_unknown')
    }
  })

  it('refuses an asset whose bytes no longer hash to the manifest', async () => {
    writeFileSync(join(bundle.root, script.path), mobileWebBundleFiller(script.byteLength, 99))
    const response = await read({ buildId: bundle.buildId, path: script.path, offset: 0 })
    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
  })
})
