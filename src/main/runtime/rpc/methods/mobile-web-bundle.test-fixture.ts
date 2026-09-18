import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../../config/scripts/vitest-host-ports-setup'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { MOBILE_WEB_BUNDLE_METHODS } from './mobile-web-bundle'
import { MOBILE_WEB_BUNDLE_CHUNK_BYTES } from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'
import {
  computeMobileWebBundleId,
  type MobileWebBundleAsset
} from '../../../../shared/mobile-web-bundle/manifest-contract'

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Deterministic, varied bytes, so a read at the wrong offset cannot accidentally look right. */
export function mobileWebBundleFiller(byteLength: number, seed: number): Buffer {
  const bytes = Buffer.alloc(byteLength)
  for (let index = 0; index < byteLength; index++) {
    bytes[index] = (index * 31 + seed * 17) % 256
  }
  return bytes
}

type SyntheticAsset = { path: string; bytes: Buffer; contentType: string }

/**
 * A bundle the real builder cannot produce today: its largest asset spans three chunks, where every
 * asset the Phase A bootstrap emits is under one. Multi-chunk paging has to be exercised rather than
 * assumed, and CI unit jobs never build out/mobile-web, so the fixture is synthetic on purpose.
 */
function syntheticAssets(seed: number): SyntheticAsset[] {
  const script = mobileWebBundleFiller(MOBILE_WEB_BUNDLE_CHUNK_BYTES * 2 + 1024, seed)
  const stylesheet = mobileWebBundleFiller(MOBILE_WEB_BUNDLE_CHUNK_BYTES, seed + 1)
  const mark = Buffer.alloc(0)
  return [
    {
      path: 'index.html',
      bytes: mobileWebBundleFiller(640, seed + 2),
      contentType: 'text/html; charset=utf-8'
    },
    {
      path: `assets/${sha256Hex(script)}.js`,
      bytes: script,
      contentType: 'text/javascript; charset=utf-8'
    },
    { path: `assets/${sha256Hex(stylesheet)}.css`, bytes: stylesheet, contentType: 'text/css' },
    { path: `assets/${sha256Hex(mark)}.png`, bytes: mark, contentType: 'image/png' }
  ]
}

export type SyntheticMobileWebBundle = {
  root: string
  buildId: string
  assets: MobileWebBundleAsset[]
}

export function writeSyntheticMobileWebBundle(
  root: string,
  seed: number
): SyntheticMobileWebBundle {
  mkdirSync(join(root, 'assets'), { recursive: true })
  const written = syntheticAssets(seed)
  for (const asset of written) {
    writeFileSync(join(root, asset.path), asset.bytes)
  }
  const assets = written
    .map((asset) => ({
      path: asset.path,
      sha256: sha256Hex(asset.bytes),
      byteLength: asset.bytes.byteLength,
      contentType: asset.contentType
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const buildId = computeMobileWebBundleId(assets)
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      buildId,
      desktopVersion: '1.4.200',
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 2,
      entrypoint: 'index.html',
      totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
      assets
    }),
    'utf8'
  )
  return { root, buildId, assets }
}

/** A dispatcher carrying only these methods. Nothing here reaches the runtime service: the bundle is
 *  read off the install, so the dispatcher's one call into it is the envelope's runtime id. */
export function mobileWebBundleDispatcher(): RpcDispatcher {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: neither mobileWeb.bundle method takes a runtime argument, so getRuntimeId (read once, to stamp the envelope) is the only member this dispatcher can reach.
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: MOBILE_WEB_BUNDLE_METHODS })
}

/** The install root the resolver probes. Installed through the port, not an electron mock: the
 *  resolver is reachable from the runtime's import graph and so must never import electron. The
 *  shared setup reinstalls a default environment before every test, so nothing here needs undoing. */
export function installMobileWebBundleAppPath(appPath: string): void {
  installFakeAppEnvironment({ getAppPath: () => appPath, getPath: () => appPath })
}
