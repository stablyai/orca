import './mobile-web-shell-protocol-test-fixtures'
import type { FakeGenerationFileSystem } from './generation-file-system-fake'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'

import type {
  MobileWebShellUpdateNotice,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

import { createElement } from 'react'
import { type ReactTestRenderer, act, create } from 'react-test-renderer'

import {
  type MobileWebBundleAsset,
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION
} from '../../../src/shared/mobile-web-bundle/manifest-contract'

import { MobileWebBundleFetchError } from '../transport/mobile-web-bundle-fetch-refusal'
import {
  type MobileWebBundleManifestRead,
  MobileWebBundleManifestReadSchema
} from '../transport/mobile-web-bundle-reply-schemas'

import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'

export const HOST_ID = 'host-1'
export const HOST_KEY = deriveHostCacheKey(HOST_ID)
export const ROUTE_PATHNAME = '/h/host-1'
export const ROUTE_PATTERN = '/h/[hostId]'

export function assetsFilled(fill: number) {
  return [
    { path: 'index.html', sha256: `${fill}`.repeat(64), byteLength: 4, contentType: 'text/html' },
    {
      path: 'assets/app.js',
      sha256: `${fill + 1}`.repeat(64),
      byteLength: 2,
      contentType: 'text/javascript'
    }
  ]
}

export const GOOD_ASSETS = assetsFilled(1)
export const NEWER_ASSETS = assetsFilled(5)
export const TOTAL_BYTES = 6
// Derive ids from assets so cached fixtures pass the manifest digest check.
export const GOOD_BUILD_ID = computeMobileWebBundleId(GOOD_ASSETS)
export const NEWER_BUILD_ID = computeMobileWebBundleId(NEWER_ASSETS)

export function manifestOf(
  assets: readonly MobileWebBundleAsset[],
  runtimeProtocolVersion = 5
): MobileWebBundleManifestRead {
  return MobileWebBundleManifestReadSchema.parse({
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion,
    pageVersion: 1,
    entrypoint: 'index.html',
    totalBytes: TOTAL_BYTES,
    assets,
    routes: [{ pathname: ROUTE_PATTERN, grants: ['navigate'] }]
  })
}

export const GOOD_MANIFEST = manifestOf(GOOD_ASSETS)
export const NEWER_MANIFEST = manifestOf(NEWER_ASSETS)
export const STALE_MANIFEST = manifestOf(GOOD_ASSETS, 0)

export function fetchResultFor(manifest: MobileWebBundleManifestRead): MobileWebBundleFetchResult {
  return {
    manifest,
    assets: new Map(
      manifest.assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])
    ),
    reused: [],
    totalBytes: TOTAL_BYTES,
    elapsedMs: 1
  }
}

// Stage/commit N through the real store so fallback reads the tree a successful download actually leaves.
export async function cacheGeneration(
  fileSystem: FakeGenerationFileSystem,
  manifest: MobileWebBundleManifestRead = GOOD_MANIFEST
): Promise<void> {
  const store = createGenerationStore({ fileSystem })
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetchResultFor(manifest)))
}

export function refuseTheAssets(): Promise<MobileWebBundleFetchResult> {
  return Promise.reject(
    new MobileWebBundleFetchError(
      'asset-short',
      'bundle asset assets/app.js ended at 1 of 2 declared bytes'
    )
  )
}

export type Mounted = {
  unmount: () => Promise<void>
  state: () => MobileWebShellSessionState
  updateNotice: () => MobileWebShellUpdateNotice | null
}

export async function mountRoute(fileSystem: FakeGenerationFileSystem): Promise<Mounted> {
  const latest: {
    state: MobileWebShellSessionState
    updateNotice: MobileWebShellUpdateNotice | null
  } = { state: { kind: 'checking' }, updateNotice: null }
  function Probe() {
    const session = useMobileWebShellSession({
      hostId: HOST_ID,
      routePathname: ROUTE_PATHNAME,
      runtime: {
        createStore: () => createGenerationStore({ fileSystem }),
        mintSessionId: () => 'session-id',
        now: () => 0,
        setTimer: () => () => {}
      }
    })
    latest.state = session.state
    latest.updateNotice = session.updateNotice
    return null
  }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(Probe))
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the hook did not mount')
  }
  return {
    unmount: async () => {
      await act(async () => {
        tree.unmount()
      })
    },
    state: () => latest.state,
    updateNotice: () => latest.updateNotice
  }
}

export const GENERATIONS_PREFIX = `${HOST_KEY}/generations/`

export function generationTree(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return fileSystem.paths().filter((path) => path.startsWith(GENERATIONS_PREFIX))
}

export function cachedBuildIds(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return [
    ...new Set(
      generationTree(fileSystem).map((path) => path.slice(GENERATIONS_PREFIX.length).split('/')[0])
    )
  ]
}
