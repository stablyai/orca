import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type {
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'

// Exercise the real hook/store over in-memory disk; stub network and native modules.
type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  manifest: MobileWebBundleManifestRead | null
  fetch: () => Promise<MobileWebBundleFetchResult>
}

const doubles = vi.hoisted((): Doubles => ({
  connection: { client: {}, state: 'connected' },
  gates: {
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  },
  manifest: null,
  fetch: () => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/mobile-endpoint-supervisor-support', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => doubles.gates
}))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: async () => {
    if (doubles.manifest === null) {
      throw new Error('the test reached the host with no manifest staged')
    }
    return { manifest: doubles.manifest }
  }
}))
vi.mock('../transport/web-bundle/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  type MobileWebBundleAsset
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from '../transport/web-bundle/mobile-web-bundle-fetch-refusal'
import { MobileWebBundleManifestReadSchema } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import {
  createFakeGenerationFileSystem,
  FAKE_GENERATION_ROOT,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'

const HOST_ID = 'host-1'
const HOST_KEY = deriveHostCacheKey(HOST_ID)
const ROUTE_PATHNAME = '/h/host-1'
const ROUTE_PATTERN = '/h/[hostId]'

function assetsFilled(fill: number) {
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

const GOOD_ASSETS = assetsFilled(1)
const NEWER_ASSETS = assetsFilled(5)
const TOTAL_BYTES = 6
// Derive ids from assets so cached fixtures pass the manifest digest check.

function manifestOf(
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

const GOOD_MANIFEST = manifestOf(GOOD_ASSETS)
const NEWER_MANIFEST = manifestOf(NEWER_ASSETS)

function fetchResultFor(manifest: MobileWebBundleManifestRead): MobileWebBundleFetchResult {
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
async function cacheGeneration(
  fileSystem: FakeGenerationFileSystem,
  manifest: MobileWebBundleManifestRead = GOOD_MANIFEST
): Promise<void> {
  const store = createGenerationStore({ fileSystem })
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetchResultFor(manifest)))
}

function refuseTheAssets(): Promise<MobileWebBundleFetchResult> {
  return Promise.reject(
    new MobileWebBundleFetchError(
      'asset-short',
      'bundle asset assets/app.js ended at 1 of 2 declared bytes'
    )
  )
}

type Mounted = {
  unmount: () => Promise<void>
  state: () => MobileWebShellSessionState
  updateNotice: () => MobileWebShellUpdateNotice | null
}

async function mountRoute(fileSystem: FakeGenerationFileSystem): Promise<Mounted> {
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

describe('an update the shell refuses while the host is reachable', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = NEWER_MANIFEST
    doubles.fetch = refuseTheAssets
  })

  it('records a failure whose error named an endpoint and a token without either', async () => {
    doubles.fetch = () =>
      Promise.reject(new Error('dial wss://relay.example/pair?token=SECRET-123 refused'))
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    await mountRoute(fileSystem)

    const log = await fileSystem.readText(`${FAKE_GENERATION_ROOT}/update-failures.json`)
    expect(log).toContain('unrecognised-error')
    expect(log).not.toMatch(/SECRET|token|\?|:\/\/|relay/)
  })
})
