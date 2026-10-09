/**
 * A layout-class change (rotation, Split View, a foldable opening) re-decides a mounted session.
 *
 * Off a wide layout a detail route is served as before; on one it is served only by a page that
 * declares `canOwnHostArea`, because an older page would draw its own sidebar beside the native
 * one. The session rebuilds on the change, so the page's in-page stack does not survive it.
 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { GenerationStore } from './generation-store'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

const doubles = vi.hoisted(
  (): {
    routes: MobileWebBundleManifestRead['routes']
    gates: {
      statusPending: boolean
      statusReadable: boolean
      hostCapabilities: string[]
      hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
    }
    manifestReads: number
    manifest: () => MobileWebBundleManifestRead
  } => ({
    routes: [],
    manifestReads: 0,
    manifest: () => ({
      schemaVersion: 1,
      buildId: 'b'.repeat(64),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 5,
      pageVersion: 1,
      entrypoint: 'index.html',
      totalBytes: 2048,
      assets: [
        { path: 'index.html', sha256: 'c'.repeat(64), byteLength: 2048, contentType: 'text/html' }
      ],
      routes: doubles.routes
    }),
    gates: {
      statusPending: false,
      statusReadable: true,
      hostCapabilities: [],
      hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
    }
  })
)

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/mobile-endpoint-supervisor-support', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/HostProtocolGate', () => ({ useHostProtocolGates: () => doubles.gates }))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: {}, state: 'connected' })
}))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: async () => {
    doubles.manifestReads += 1
    return { manifest: doubles.manifest() }
  }
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => new Promise(() => {})
}))

import { useMobileWebShellSession } from './use-mobile-web-shell-session'

const store: GenerationStore = {
  // The same build on disk, so a session opens it and reaches `ready` without a download.
  readActiveGeneration: async () => ({
    buildId: 'b'.repeat(64),
    directory: 'file:///cache/gen',
    manifest: doubles.manifest()
  }),
  stageGeneration: async () => {
    throw new Error('not reached')
  },
  commitGeneration: async () => {
    throw new Error('not reached')
  },
  abortStagedGeneration: async () => undefined,
  sweepStagedGenerations: async () => undefined,
  deleteHostCache: async () => undefined,
  persistActiveManifest: async () => 'persisted',
  recordUpdateFailure: async () => undefined,
  readUpdateFailures: async () => [],
  forgetHostUpdateFailures: async () => undefined
}

function routes(declares: boolean): MobileWebBundleManifestRead['routes'] {
  return [
    {
      pathname: '/h/[hostId]',
      grants: ['navigate'],
      ...(declares ? { canOwnHostArea: true } : {})
    },
    { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'] }
  ]
}

async function settledKinds(
  declares: boolean,
  widths: readonly boolean[],
  routePathname = '/h/host-1/session/wt-1'
) {
  doubles.routes = routes(declares)
  doubles.manifestReads = 0
  doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
  const seen: MobileWebShellSessionState[] = []
  let minted = 0
  function Probe({ wide }: { wide: boolean }) {
    const session = useMobileWebShellSession({
      hostId: 'host-1',
      routePathname,
      wide,
      runtime: {
        createStore: () => store,
        mintSessionId: () => `session-${String((minted += 1))}`,
        now: () => 0,
        setTimer: () => () => {}
      }
    })
    seen.push(session.state)
    return null
  }
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  const kinds: string[] = []
  for (const wide of widths) {
    await act(async () => {
      if (mounted.tree === null) {
        mounted.tree = create(<Probe wide={wide} />)
      } else {
        mounted.tree.update(<Probe wide={wide} />)
      }
    })
    await act(async () => {})
    const state = seen.at(-1)
    kinds.push(state?.kind === 'ready' ? `ready ${state.sessionId}` : (state?.kind ?? 'none'))
  }
  act(() => mounted.tree?.unmount())
  return { kinds, manifestReads: doubles.manifestReads }
}

describe('a detail session across a layout-class change', () => {
  // Once per flip: the wide session may not keep the host-route hop the narrow one could.
  it('restarts an open page once per flip under a declaring bundle', async () => {
    expect(await settledKinds(true, [false, true, false])).toEqual({
      kinds: ['ready session-1', 'ready session-2', 'ready session-3'],
      manifestReads: 3
    })
  })

  it('goes native on a wide layout under a page without the declaration, and back', async () => {
    expect(await settledKinds(false, [false, true, false])).toEqual({
      kinds: ['ready session-1', 'native-route', 'ready session-2'],
      manifestReads: 3
    })
  })

  it('rebuilds the host route, whose wide session owns the area under other grants', async () => {
    const { kinds } = await settledKinds(true, [false, true], '/h/host-1')
    expect(kinds).toEqual(['ready session-1', 'ready session-2'])
  })
})

describe('a phone mount', () => {
  // The layout effect fires once on mount; on a phone it must be a no-op, not a restart.
  it.each([
    [true, '/h/host-1'],
    [true, '/h/host-1/session/wt-1'],
    [false, '/h/host-1'],
    [false, '/h/host-1/session/wt-1']
  ])('declares=%s, %s: one session, one manifest read', async (declares, routePathname) => {
    expect(await settledKinds(declares, [false, false], routePathname)).toEqual({
      kinds: ['ready session-1', 'ready session-1'],
      manifestReads: 1
    })
  })
})
