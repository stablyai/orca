import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

/**
 * A route-grant edit on the desktop moves no asset, so the bundle keeps its build id. The phone
 * uses the fresh grants for the online session but never rewrites the stored manifest, so an
 * offline entry is judged by the grants the assets were downloaded with.
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

/** Through the phone's own reader, not as a literal: that parse is what the manifest the reducer
 *  holds has really been through, and it is the one that pins the build id to the digest of the
 *  assets — so a fixture these tests could not have received is refused here rather than measured. */
function manifestGranting(grants: readonly string[]): MobileWebBundleManifestRead {
  return MobileWebBundleManifestReadSchema.parse({
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: BUILD_ID,
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 5,
    pageVersion: 1,
    entrypoint: 'index.html',
    totalBytes: TOTAL_BYTES,
    assets: ASSETS,
    routes: [{ pathname: ROUTE_PATTERN, grants: [...grants] }]
  })
}

/** The edit the desktop published. */
const M2 = manifestGranting(GRANTS_A_PLUS_B)

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
    reused: [],
    totalBytes: TOTAL_BYTES,
    elapsedMs: 1
  }
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetched))
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
 * Production hands every mount the one process store; this cold start builds its own per mount, as
 * a relaunch does, so the second mount reads the manifest that reached the file, not a queued one.
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
  // Nothing is awaited after the mount: every effect in this flow is microtask-only (a cache read
  // and a manifest read, neither on a timer), so the `act` above drains the whole chain.
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

  it('opens a same-build hit online without writing to the generation directory', async () => {
    // The native view reads `manifest.json` while the page opens; a rewrite here raced that read.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A))
    const generationPaths = () =>
      fileSystem.paths().filter((path) => path.startsWith(`${HOST_KEY}/generations/`))
    const paths = generationPaths()
    const settled = fileSystem.writes.length
    doubles.manifest = M2

    const online = await mountRoute(fileSystem)

    expect(online.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(online.routeGrants()).toEqual(GRANTS_A_PLUS_B)
    const generationWrites = fileSystem.writes
      .slice(settled)
      .filter((path) => path.startsWith(`${HOST_KEY}/generations/`))
    expect(generationWrites).toEqual([])
    expect(generationPaths()).toEqual(paths)
    await online.unmount()
  })

  it('reads the grants the assets arrived with, whatever a later online read accepted', async () => {
    // The accepted tradeoff: offline verdicts use the routes stored at download time.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, manifestGranting(GRANTS_A))
    doubles.manifest = M2
    const online = await mountRoute(fileSystem)
    expect(online.routeGrants()).toEqual(GRANTS_A_PLUS_B)
    await online.unmount()

    goOffline()
    const offline = await mountRoute(fileSystem)

    expect(offline.state()).toMatchObject({ kind: 'ready', buildId: BUILD_ID })
    expect(offline.routeGrants()).toEqual(GRANTS_A)
  })
})
