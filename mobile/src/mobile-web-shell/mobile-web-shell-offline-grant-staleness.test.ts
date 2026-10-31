import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

// Grant-only edits keep the build id: use fresh grants online but preserve the downloaded manifest for offline entry. Test cold mounts sharing only the real store’s disk.
type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  manifest: MobileWebBundleManifestRead | null
}

const doubles = vi.hoisted((): Doubles => ({
  connection: { client: {}, state: 'connected' },
  gates: {
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  },
  manifest: null
}))

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../../modules/orca-mobile-web-shell/src', () => ({
  excludeFromBackup: async () => undefined
}))
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
// Downloads are unexpected: these flows must use the same-build cache or wall it.
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
const ROUTE_PATHNAME = '/h/host-1'
const ROUTE_PATTERN = '/h/[hostId]'
const GRANTS_A = ['navigate']
const GRANTS_A_PLUS_B = ['navigate', 'storage']

const ASSETS = [
  { path: 'index.html', sha256: '1'.repeat(64), byteLength: 4, contentType: 'text/html' },
  { path: 'assets/app.js', sha256: '2'.repeat(64), byteLength: 2, contentType: 'text/javascript' }
]
const TOTAL_BYTES = ASSETS.reduce((sum, asset) => sum + asset.byteLength, 0)
// Derive ids from assets so cached fixtures pass the manifest digest check.
const BUILD_ID = computeMobileWebBundleId(ASSETS)

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

const M2 = manifestGranting(GRANTS_A_PLUS_B)

// Stage/commit through the real store so the later cold mount reads the manifest a download actually leaves.
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

// Remove both connection and manifest; any accidental host read must fail instead of silently agreeing with cached routes.
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
    // Do not rewrite manifest.json while the native view may read it during page open.
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
