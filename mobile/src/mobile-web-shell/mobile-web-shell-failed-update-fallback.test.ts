import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type {
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'

/**
 * Phase D of the hybrid RC emulator run, end to end and against a disk.
 *
 * The host is reachable and serves a generation whose assets do not arrive intact. Refusing them is
 * right — the fetch hashes every asset, and a truncated one is not a bundle. What the shell then
 * did was paint a refusal wall with a "Try again" over a generation already on disk that it would
 * have opened without being asked the moment the host went away.
 *
 * The reducer suite pins the decision; this pins the two things only a disk can answer: the refused
 * generation never reaches the cache, and the next launch asks the host again rather than living
 * under a fallback forever.
 */
type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  /** What the host answers `mobileWebBundleManifestRead` with on this mount. */
  manifest: MobileWebBundleManifestRead | null
  /** What the asset fetch does on this mount: the refused read, or the bytes. */
  fetch: () => Promise<MobileWebBundleFetchResult>
}

const doubles = vi.hoisted((): Doubles => ({
  connection: { client: {}, state: 'connected' },
  gates: {
    statusPending: false,
    statusReadable: true,
    // Filled in `beforeEach`: a hoisted factory runs before this module's imports do.
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
vi.mock('../components/HostProtocolGate', () => ({ useHostProtocolGates: () => doubles.gates }))
vi.mock('../transport/client-context', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: async () => {
    if (doubles.manifest === null) {
      throw new Error('the test reached the host with no manifest staged')
    }
    return { manifest: doubles.manifest }
  }
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  type MobileWebBundleAsset
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from '../transport/mobile-web-bundle-fetch-refusal'
import { MobileWebBundleManifestReadSchema } from '../transport/mobile-web-bundle-reply-schemas'
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

/** Two bundles: the one this phone already runs, and the one the host has moved on to. Different
 *  bytes, so different ids, which is what makes the second an update rather than a cache hit. */
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
/** The id the assets decide, because the cached manifest is read back through the schema that pins
 *  it to their digest: a literal would be refused before any of this could be measured. */
const GOOD_BUILD_ID = computeMobileWebBundleId(GOOD_ASSETS)
const NEWER_BUILD_ID = computeMobileWebBundleId(NEWER_ASSETS)

/** Through the phone's own reader, so a fixture these tests could not have received is refused
 *  here rather than measured. */
function manifestOf(
  assets: readonly MobileWebBundleAsset[],
  runtimeProtocolVersion = 5
): MobileWebBundleManifestRead {
  return MobileWebBundleManifestReadSchema.parse({
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion,
    entrypoint: 'index.html',
    totalBytes: TOTAL_BYTES,
    assets,
    routes: [{ pathname: ROUTE_PATTERN, grants: ['navigate'] }]
  })
}

const GOOD_MANIFEST = manifestOf(GOOD_ASSETS)
const NEWER_MANIFEST = manifestOf(NEWER_ASSETS)
/** The same assets under a manifest the host's stated floor has moved past: the doubles answer
 *  `minCompatibleMobileVersion: 1`, so a bundle runtime of 0 is below it. */
const STALE_MANIFEST = manifestOf(GOOD_ASSETS, 0)

function fetchResultFor(manifest: MobileWebBundleManifestRead): MobileWebBundleFetchResult {
  return {
    manifest,
    assets: new Map(
      manifest.assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])
    ),
    totalBytes: TOTAL_BYTES,
    elapsedMs: 1
  }
}

/** Generation N on disk, written by the store's own stage-and-commit rather than seeded as files:
 *  what a fallback opens has to be a tree the download path really leaves. */
async function cacheGeneration(
  fileSystem: FakeGenerationFileSystem,
  manifest: MobileWebBundleManifestRead = GOOD_MANIFEST
): Promise<void> {
  const store = createGenerationStore({ fileSystem })
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetchResultFor(manifest)))
}

/** What a truncated asset really produces: the fetch's own refusal, which is nothing the transport
 *  predicate recognises as the link going. */
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

/** One cold start of the route: a fresh store over the tree already on disk, as a relaunch gets. */
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

const GENERATIONS_PREFIX = `${HOST_KEY}/generations/`

function generationTree(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return fileSystem.paths().filter((path) => path.startsWith(GENERATIONS_PREFIX))
}

/** Every generation directory this host holds, which is one for a cache that committed cleanly. */
function cachedBuildIds(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return [
    ...new Set(
      generationTree(fileSystem).map((path) => path.slice(GENERATIONS_PREFIX.length).split('/')[0])
    )
  ]
}

describe('an update the shell refuses while the host is reachable', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = NEWER_MANIFEST
    doubles.fetch = refuseTheAssets
  })

  it('serves the generation on disk instead of a wall, and says why', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    expect(mounted.updateNotice()).toBe('update-failed')
  })

  it('leaves the refused generation off the disk and the intact one on it', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const settled = generationTree(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready' })

    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
    // File for file: the refusal wrote nothing over the intact tree and deleted nothing from it.
    expect(generationTree(fileSystem)).toEqual(settled)
    // And left no residue of its own. The fetch refuses before a byte is staged, so the staging
    // tree the launch sweep cleared is still clear.
    expect(fileSystem.paths().filter((path) => path.includes('/tmp'))).toEqual([])
  })

  it('walls as it always did when there is no generation to fall back to', async () => {
    const fileSystem = createFakeGenerationFileSystem()

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(mounted.updateNotice()).toBeNull()
  })

  it('walls a generation whose declared runtime the host has moved past', async () => {
    // Read back off the disk, not handed in: the manifest the wall is decided from is the one the
    // commit really left beside the assets, which is the only record of what these bytes declare.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, STALE_MANIFEST)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      }
    })
    expect(mounted.updateNotice()).toBeNull()
    // Walled, not deleted: the bytes are intact and a newer host is not what makes them wrong.
    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
  })

  it('serves the generation still inside that window, which is the same disk one field apart', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, GOOD_MANIFEST)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    expect(mounted.updateNotice()).toBe('update-failed')
  })

  it('writes down why on the device, which is all a release build keeps', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([
      {
        hostId: HOST_ID,
        at: 0,
        reason: 'asset-short',
        hostCode: null,
        offeredBuildId: NEWER_BUILD_ID,
        cachedBuildId: GOOD_BUILD_ID,
        outcome: 'opened-cached',
        wall: null
      }
    ])
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

  it("forgets this host's failures once a newer generation commits, and no other host's", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const other = {
      hostId: 'host-2',
      at: 0,
      reason: 'connection-lost',
      hostCode: null,
      offeredBuildId: null,
      cachedBuildId: null,
      outcome: 'opened-cached',
      wall: null
    } as const
    await createGenerationStore({ fileSystem }).recordUpdateFailure(other)

    await (await mountRoute(fileSystem)).unmount()
    const afterRefusal = await createGenerationStore({ fileSystem }).readUpdateFailures()
    expect(afterRefusal.map((entry) => entry.hostId)).toEqual(['host-2', HOST_ID])

    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)
    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([other])
  })

  it('asks the host again on the next launch rather than living under the fallback', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const refused = await mountRoute(fileSystem)
    expect(refused.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    await refused.unmount()

    // The same host, now serving assets that arrive whole. Nothing on disk had to be cleared for
    // this: the fallback is a decision, not a state anything was written into.
    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)

    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })
    expect(updated.updateNotice()).toBeNull()
    expect(cachedBuildIds(fileSystem)).toEqual([NEWER_BUILD_ID])
  })
})
