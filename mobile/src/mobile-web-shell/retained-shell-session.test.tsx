import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { ActiveGeneration, GenerationStore } from './generation-store'
import {
  evictRetainedShellSession,
  readRetainedPageHostSnapshot,
  recordRetainedPageHostSnapshot
} from './retained-shell-session-store'
import { deleteHostPageCache } from './removed-host-shell-cache'
import {
  useMobileWebShellSession,
  type MobileWebShellSessionView
} from './use-mobile-web-shell-session'

const doubles = vi.hoisted(() => {
  const manifest: MobileWebBundleManifestRead = {
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
    routes: [
      { pathname: '/h/[hostId]', grants: ['navigate'] },
      { pathname: '/h/[hostId]/accounts', grants: ['navigate'] },
      { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'] }
    ]
  }
  const connection: { client: object | null; state: string } = { client: {}, state: 'connected' }
  const hostCapabilities: string[] = ['mobileWebBundle']
  return {
    connection,
    gates: {
      statusPending: false,
      statusReadable: true,
      hostCapabilities,
      hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
    },
    manifestReads: 0,
    manifest
  }
})

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined }
}))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => doubles.gates
}))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: async () => {
    doubles.manifestReads += 1
    return { manifest: doubles.manifest }
  }
}))
vi.mock('./process-generation-store', () => ({
  processGenerationStore: () => ({
    deleteHostCache: async () => undefined,
    forgetHostUpdateFailures: async () => undefined
  })
}))

const DIRECTORY = 'file:///cache/mobile-web/host/generations/b'

function createCachedStore(): { store: GenerationStore; cacheReads: () => number } {
  let cacheReads = 0
  const active: ActiveGeneration = {
    buildId: doubles.manifest.buildId,
    directory: DIRECTORY,
    manifest: doubles.manifest
  }
  return {
    cacheReads: () => cacheReads,
    store: {
      readActiveGeneration: async () => {
        cacheReads += 1
        return active
      },
      stageGeneration: async () => ({
        hostKey: 'host-key',
        buildId: doubles.manifest.buildId,
        directory: DIRECTORY,
        manifest: doubles.manifest
      }),
      commitGeneration: async () => active,
      abortStagedGeneration: async () => undefined,
      sweepStagedGenerations: async () => undefined,
      deleteHostCache: async () => undefined,
      recordUpdateFailure: async () => undefined,
      readUpdateFailures: async () => [],
      forgetHostUpdateFailures: async () => undefined
    }
  }
}

describe('single-host LRU retained shell session', () => {
  let sessionCounter = 0

  beforeEach(() => {
    sessionCounter = 0
    evictRetainedShellSession()
    doubles.manifestReads = 0
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
  })

  async function mountForHost(
    hostId: string,
    store: GenerationStore,
    routePathname = `/h/${hostId}`
  ) {
    const firstRender: {
      stateKind: string | null
      sessionId: string | null
      pageFrame: string | null
      pageReady: boolean | null
    } = {
      stateKind: null,
      sessionId: null,
      pageFrame: null,
      pageReady: null
    }
    const latest: { view: MobileWebShellSessionView | null } = { view: null }

    function Probe(): null {
      const view = useMobileWebShellSession({
        hostId,
        routePathname,
        runtime: {
          createStore: () => store,
          mintSessionId: () => `session-${++sessionCounter}`,
          now: () => 0,
          setTimer: () => () => undefined
        }
      })
      if (firstRender.stateKind === null) {
        firstRender.stateKind = view.state.kind
        firstRender.sessionId = view.state.kind === 'ready' ? view.state.sessionId : null
        firstRender.pageFrame = view.pageFrame
        firstRender.pageReady = view.pageReady
      }
      latest.view = view
      return null
    }

    let tree: ReactTestRenderer | null = null
    await act(async () => {
      tree = create(createElement(Probe))
    })
    return {
      firstRender,
      view: () => {
        if (latest.view === null) {
          throw new Error('session hook did not render')
        }
        return latest.view
      },
      unmount: async () => {
        await act(async () => {
          tree?.unmount()
        })
      }
    }
  }

  it('re-enters a painted host session on frame 1 with the same sessionId and painted frame', async () => {
    const { store, cacheReads } = createCachedStore()
    recordRetainedPageHostSnapshot('host-1', {
      host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 1 }
    })

    const first = await mountForHost('host-1', store)
    expect(first.firstRender.stateKind).toBe('checking')
    expect(first.view().state.kind).toBe('ready')
    await act(async () => {
      first.view().reportDocumentLoaded()
      first.view().reportPageReady()
      first.view().reportPagePainted()
    })
    expect(first.view().pageFrame).toBe('painted')
    expect(readRetainedPageHostSnapshot('host-1')?.host.id).toBe('host-1')
    await first.unmount()

    const second = await mountForHost('host-1', store)
    expect(second.firstRender).toEqual({
      stateKind: 'ready',
      sessionId: 'session-1',
      pageFrame: 'painted',
      pageReady: true
    })
    // Re-entry skips open-cache and checks manifest in the background while keeping session-1 live.
    expect(cacheReads()).toBe(1)
    expect(doubles.manifestReads).toBe(2)
    await second.unmount()
  })

  it('evicts host-1 when host-2 is painted, keeping at most 1 host retained', async () => {
    const { store } = createCachedStore()
    const host1 = await mountForHost('host-1', store)
    await act(async () => {
      host1.view().reportDocumentLoaded()
      host1.view().reportPageReady()
      host1.view().reportPagePainted()
    })
    await host1.unmount()

    const host2 = await mountForHost('host-2', store)
    expect(host2.firstRender.stateKind).toBe('checking')
    await act(async () => {
      host2.view().reportDocumentLoaded()
      host2.view().reportPageReady()
      host2.view().reportPagePainted()
    })
    await host2.unmount()

    const host1Again = await mountForHost('host-1', store)
    expect(host1Again.firstRender.stateKind).toBe('checking')
    await host1Again.unmount()
  })

  it('evicts the retained session when deleteHostPageCache is called for that host', async () => {
    const { store } = createCachedStore()
    const first = await mountForHost('host-1', store)
    await act(async () => {
      first.view().reportDocumentLoaded()
      first.view().reportPageReady()
      first.view().reportPagePainted()
    })
    await first.unmount()

    await deleteHostPageCache('host-1')

    const second = await mountForHost('host-1', store)
    expect(second.firstRender.stateKind).toBe('checking')
    await second.unmount()
  })

  it('restores the parent host route in the retained slot when backing out after a child session route', async () => {
    const { store } = createCachedStore()
    const hostRoot = await mountForHost('host-1', store, '/h/host-1')
    await act(async () => {
      hostRoot.view().reportDocumentLoaded()
      hostRoot.view().reportPageReady()
      hostRoot.view().reportPagePainted()
    })

    // Push a child workspace route while hostRoot stays mounted underneath in HostStack.
    const childSession = await mountForHost('host-1', store, '/h/host-1/session/wt-1')
    await act(async () => {
      childSession.view().reportDocumentLoaded()
      childSession.view().reportPageReady()
      childSession.view().reportPagePainted()
    })
    // Pop child session first, then pop hostRoot back to '/'.
    await childSession.unmount()
    await hostRoot.unmount()

    // Re-entering '/h/host-1' must hit the retained parent session (session-1) immediately.
    const reentered = await mountForHost('host-1', store, '/h/host-1')
    expect(reentered.firstRender).toEqual({
      stateKind: 'ready',
      sessionId: 'session-1',
      pageFrame: 'painted',
      pageReady: true
    })
    await reentered.unmount()
  })

  it('keeps the parked host page when Account usage opens and then fails', async () => {
    const { store } = createCachedStore()
    const hostRoot = await mountForHost('host-1', store, '/h/host-1')
    await act(async () => {
      hostRoot.view().reportDocumentLoaded()
      hostRoot.view().reportPageReady()
      hostRoot.view().reportPagePainted()
    })
    await hostRoot.unmount()

    const accounts = await mountForHost('host-1', store, '/h/host-1/accounts')
    await act(async () => {
      accounts.view().reportDocumentLoaded()
      accounts.view().reportPageReady()
      accounts.view().reportPagePainted()
    })
    await act(async () => {
      accounts.view().reportShellFailure('document-load-failed')
    })
    await accounts.unmount()

    const reentered = await mountForHost('host-1', store, '/h/host-1')
    expect(reentered.firstRender).toEqual({
      stateKind: 'ready',
      sessionId: 'session-1',
      pageFrame: 'painted',
      pageReady: true
    })
    await reentered.unmount()
  })

  it('evicts the parked host page when a child route commits a newer generation on disk', async () => {
    const { store } = createCachedStore()
    const hostRoot = await mountForHost('host-1', store, '/h/host-1')
    await act(async () => {
      hostRoot.view().reportDocumentLoaded()
      hostRoot.view().reportPageReady()
      hostRoot.view().reportPagePainted()
    })
    await hostRoot.unmount()

    const newerBuildId = 'd'.repeat(64)
    const previousManifest = doubles.manifest
    try {
      doubles.manifest = { ...previousManifest, buildId: newerBuildId }
      const { store: newerStore } = createCachedStore()
      const accounts = await mountForHost('host-1', newerStore, '/h/host-1/accounts')
      await act(async () => {
        accounts.view().reportDocumentLoaded()
        accounts.view().reportPageReady()
        accounts.view().reportPagePainted()
      })
      expect(accounts.view().state).toMatchObject({
        kind: 'ready',
        buildId: newerBuildId
      })
      await accounts.unmount()

      const reentered = await mountForHost('host-1', newerStore, '/h/host-1')
      expect(reentered.firstRender.stateKind).toBe('checking')
      expect(reentered.view().state).toMatchObject({
        kind: 'ready',
        buildId: newerBuildId
      })
      await reentered.unmount()
    } finally {
      doubles.manifest = previousManifest
    }
  })
})
