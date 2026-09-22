import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

/**
 * The whole of finding 7 on #21503, end to end and against a disk.
 *
 * A route-grant edit on the desktop moves no asset, so the bundle keeps its build id: the phone
 * holds the right bytes under a manifest an edit behind, and that stored manifest is the only
 * evidence an offline entry has. Every other suite here stops at one of the seams — the reducer's
 * effect list, or the store handed a manifest by a test — so none of them can tell whether the
 * effect the reducer emits reaches the file the next cold start reads.
 *
 * So this one mounts the real hook over the real store over an in-memory disk, and the only doubles
 * are the network and the platform modules the runtime cannot load under vitest. What it measures
 * is the offline verdict of a second mount that shares nothing with the first but the tree on disk.
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
  manifest: null
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
// Never reached below: every flow here is a same-build cache hit or a wall, and a download starting
// would mean the shell had decided the bytes on disk were not the ones the manifest names.
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => Promise.reject(new Error('no flow in this suite downloads'))
}))

import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { MobileWebBundleManifestReadSchema } from '../transport/mobile-web-bundle-reply-schemas'
import {
  createFakeGenerationFileSystem,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'

const HOST_ID = 'host-1'
const HOST_KEY = deriveHostCacheKey(HOST_ID)
/** The screen this phone is on, and the pattern both manifests list it under. */
const ROUTE_PATHNAME = '/h/host-1'
const ROUTE_PATTERN = '/h/[hostId]'
/** The grants before the desktop's edit, and after it. Both names are ones this shell implements,
 *  so the route is served either way and the grant list is the only thing that moves. */
const GRANTS_A = ['navigate']
const GRANTS_A_PLUS_B = ['navigate', 'storage']

const ASSETS = [
  { path: 'index.html', sha256: '1'.repeat(64), byteLength: 4, contentType: 'text/html' },
  { path: 'assets/app.js', sha256: '2'.repeat(64), byteLength: 2, contentType: 'text/javascript' }
]
const TOTAL_BYTES = ASSETS.reduce((sum, asset) => sum + asset.byteLength, 0)
/** The id the assets decide, because the cached manifest is read back through the schema that pins
 *  it to their digest: a literal would be refused before any of this could be measured. */
const BUILD_ID = computeMobileWebBundleId(ASSETS)
const MANIFEST_PATH = `${HOST_KEY}/generations/${BUILD_ID}/manifest.json`

/** Through the phone's own reader, not as a literal: that parse is what the manifest the reducer
 *  holds has really been through, and it is the one that pins the build id to the digest of the
 *  assets — so a fixture these tests could not have received is refused here rather than measured. */
function manifestGranting(
  grants: readonly string[],
  overrides: Partial<MobileWebBundleManifestRead> = {}
): MobileWebBundleManifestRead {
  return MobileWebBundleManifestReadSchema.parse({
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: BUILD_ID,
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 5,
    entrypoint: 'index.html',
    totalBytes: TOTAL_BYTES,
    assets: ASSETS,
    routes: [{ pathname: ROUTE_PATTERN, grants: [...grants] }],
    ...overrides
  })
}

/** The edit the desktop published, and that same edit written in a manifest schema this shell does
 *  not know. */
const M2 = manifestGranting(GRANTS_A_PLUS_B)
const M2_WALLED = manifestGranting(GRANTS_A_PLUS_B, {
  schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION + 1
})

/** Generation G on disk under the manifest its assets arrived with, written by the store's own
 *  stage-and-commit rather than seeded as files: what this suite is about is the manifest a later
 *  read finds, so the first one has to be the one the download path really leaves. */
async function cacheGeneration(
  fileSystem: FakeGenerationFileSystem,
  manifest: MobileWebBundleManifestRead
): Promise<void> {
  const store = createGenerationStore({ fileSystem })
  const fetched: MobileWebBundleFetchResult = {
    manifest,
    assets: new Map(ASSETS.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])),
    totalBytes: TOTAL_BYTES,
    elapsedMs: 1
  }
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetched))
}

function storedRouteGrants(fileSystem: FakeGenerationFileSystem): unknown {
  const text = fileSystem.text(MANIFEST_PATH)
  return text === null ? null : JSON.parse(text).routes
}

type Mounted = {
  unmount: () => Promise<void>
  state: () => MobileWebShellSessionState
  pageRoutes: () => readonly string[]
  routeGrants: () => readonly string[]
}

/**
 * One cold start of the route: a fresh store over the tree already on disk, as a relaunch gets.
 *
 * `createStore` mints a new store per mount rather than sharing one, because a store holds a
 * serialisation queue and nothing else — a shared one would let the second mount read a manifest
 * the first had in memory instead of the one that reached the file.
 */
async function mountRoute(fileSystem: FakeGenerationFileSystem): Promise<Mounted> {
  const latest: {
    state: MobileWebShellSessionState
    pageRoutes: readonly string[]
    routeGrants: readonly string[]
  } = { state: { kind: 'checking' }, pageRoutes: [], routeGrants: [] }
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
    latest.pageRoutes = session.pageRoutes
    latest.routeGrants = session.routeGrants
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
  // Nothing is awaited after the mount: every effect in this flow is microtask-only — a cache read,
  // a manifest read and the write-through, none of them on a timer — so the `act` above drains the
  // whole chain. A write that never reaches disk fails on the stale manifest below rather than on a
  // wait, which is what makes this measure the write instead of the waiting.
  return {
    unmount: async () => {
      await act(async () => {
        tree.unmount()
      })
    },
    state: () => latest.state,
    pageRoutes: () => latest.pageRoutes,
    routeGrants: () => latest.routeGrants
  }
}

/**
 * The host is gone, and so is anything it could still answer.
 *
 * The manifest is cleared as well as the connection: the mocked read throws without one, so a mount
 * that reached the host on this leg would fail its flow rather than quietly agree with the disk.
 * What follows is then a verdict the tree on disk is the whole evidence for.
 */
function goOffline(): void {
  doubles.connection = { client: null, state: 'disconnected' }
  doubles.manifest = null
}

describe('an offline cold start after a grant-only manifest edit', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = null
  })

  it('reads the grants the last online read accepted, not the ones the assets arrived with', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A))
    doubles.manifest = M2

    const online = await mountRoute(fileSystem)
    expect(online.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(online.routeGrants()).toEqual(GRANTS_A_PLUS_B)
    // The write-through reached the file, which is the step no other suite covers.
    expect(storedRouteGrants(fileSystem)).toEqual([
      { pathname: ROUTE_PATTERN, grants: GRANTS_A_PLUS_B }
    ])
    await online.unmount()

    goOffline()
    const offline = await mountRoute(fileSystem)

    expect(offline.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(offline.pageRoutes()).toEqual([ROUTE_PATTERN])
    expect(offline.routeGrants()).toEqual(GRANTS_A_PLUS_B)
  })

  it('drops a grant the desktop took away, rather than keeping it for as long as the host is gone', async () => {
    // The direction that costs something to get wrong: a revoked capability the phone goes on
    // exercising offline. Same mechanism, read the other way.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A_PLUS_B))
    doubles.manifest = manifestGranting(GRANTS_A)

    const online = await mountRoute(fileSystem)
    expect(online.routeGrants()).toEqual(GRANTS_A)
    await online.unmount()

    goOffline()
    const offline = await mountRoute(fileSystem)

    expect(offline.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(offline.routeGrants()).toEqual(GRANTS_A)
  })

  it('reads the grants the assets arrived with when no online read reached this phone', async () => {
    // The discriminator, and what every offline verdict answered before the write-through: the same
    // cold start over a generation the desktop's edit never got to.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A))

    goOffline()
    const offline = await mountRoute(fileSystem)

    expect(offline.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(offline.routeGrants()).toEqual(GRANTS_A)
  })
})

/**
 * The arm the write-through deliberately skips.
 *
 * A manifest this shell walled is one it has declared it cannot read, and an offline entry runs no
 * compat check. Writing it would have the next cold start open the page under the grants of a
 * bundle this shell had just refused — so disk keeps the last manifest this shell accepted, and the
 * offline verdict is the one that manifest decides.
 */
describe('an offline cold start after a grant edit arrived under a wall', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = null
  })

  it('leaves the stored manifest alone and reads the grants it had accepted', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A))
    doubles.manifest = M2_WALLED
    const settled = fileSystem.writes.length

    const walled = await mountRoute(fileSystem)
    expect(walled.state()).toMatchObject({ kind: 'wall' })
    // Nothing was written at all, so not even the pending half of a swap is on disk.
    expect(fileSystem.writes).toHaveLength(settled)
    expect(storedRouteGrants(fileSystem)).toEqual([{ pathname: ROUTE_PATTERN, grants: GRANTS_A }])
    await walled.unmount()

    goOffline()
    const offline = await mountRoute(fileSystem)

    expect(offline.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(offline.routeGrants()).toEqual(GRANTS_A)
  })
})
