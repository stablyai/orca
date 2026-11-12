import { mkdtempSync, rmSync, truncateSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MobileWebBundleManifestResultSchema } from '../../../../../shared/mobile-web-bundle/bundle-rpc-contract'

import '../../server/runtime-rpc-mobile-method-allowlist'
import type { RpcRequest, RpcResponse } from '../../core'

import '../../../../../shared/orcad-artifacts'
import type { RpcDispatcher } from '../../dispatcher'

import {
  fillMobileWebBundleReadWindow,
  resetMobileWebBundleAssetVerdictsForTests
} from './mobile-web-bundle-asset-reader'

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

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-bundle-'))
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

describe('an install that carries a mobile web bundle', () => {
  let bundle: SyntheticMobileWebBundle

  beforeEach(() => {
    bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 1)
  })

  // Linux package managers replace the install under a running host (STA-14385): serve the new build, never the gone one.
  it('serves the replacement build after the install swaps bundles under a running host', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect((await call('mobileWeb.bundle.manifest')).ok).toBe(true)
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)

    rmSync(join(scratch, 'out', 'mobile-web'), { recursive: true, force: true })
    const replacement = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 2)
    expect(replacement.buildId).not.toBe(bundle.buildId)

    const stale = await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })
    const manifest = await call('mobileWeb.bundle.manifest')
    const fresh = await chunk({ buildId: replacement.buildId, path: 'index.html', offset: 0 })

    expect(errorMessage(stale)).toBe('mobile_web_bundle_build_changed')
    expect(
      MobileWebBundleManifestResultSchema.parse(manifest.ok && manifest.result).manifest.buildId
    ).toBe(replacement.buildId)
    expect(errorMessage(fresh)).toBeUndefined()
  })

  // Truncation after verification must not return a short chunk and let clients page past missing bytes.
  it('answers a changed asset when the file is shorter than the manifest promised', async () => {
    const script = bundle.assets.find((asset) => asset.path.endsWith('.js'))!
    expect((await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })).ok).toBe(true)
    truncateSync(join(bundle.root, script.path), 100)

    const response = await chunk({ buildId: bundle.buildId, path: script.path, offset: 0 })

    expect(errorMessage(response)).toBe('mobile_web_bundle_asset_changed')
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
})
