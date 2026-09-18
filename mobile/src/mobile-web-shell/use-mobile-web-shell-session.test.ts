import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { ActiveGeneration, GenerationStore, StagedGeneration } from './generation-store'

/**
 * The runner, not the rules: what the reducer decides has table tests, and this covers the three
 * things only the wiring can get wrong — abandoning an effect whose session is gone, aborting the
 * bytes it was pulling, and doing both again when someone taps Try again. A cancellation that is
 * merely intended is a download that keeps four of the host's read slots and a cache write that
 * lands under a host nobody is looking at any more.
 *
 * The React Native and Expo modules are mocked at the edge of the import graph rather than stubbed
 * one deep, because importing any of them pulls the runtime this test does not have.
 */
type Settle<T> = (value: T) => void

type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  manifestReads: number
  manifestClients: unknown[]
  fetches: { signal: AbortSignal; settle: Settle<MobileWebBundleFetchResult> }[]
  manifest: MobileWebBundleManifestRead
}

const doubles = vi.hoisted((): Doubles => {
  const manifest: MobileWebBundleManifestRead = {
    schemaVersion: 1,
    buildId: 'b'.repeat(64),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 5,
    entrypoint: 'index.html',
    totalBytes: 2048,
    assets: [
      { path: 'index.html', sha256: 'c'.repeat(64), byteLength: 2048, contentType: 'text/html' }
    ]
  }
  return {
    connection: { client: {}, state: 'connected' },
    gates: {
      statusPending: false,
      statusReadable: true,
      // Filled in `beforeEach`: a hoisted factory runs before this module's imports do.
      hostCapabilities: [],
      hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
    },
    manifestReads: 0,
    manifestClients: [],
    fetches: [],
    manifest
  }
})

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/mobile-endpoint-supervisor-support', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/HostProtocolGate', () => ({ useHostProtocolGates: () => doubles.gates }))
vi.mock('../transport/client-context', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: async (client: unknown) => {
    doubles.manifestReads += 1
    doubles.manifestClients.push(client)
    return { manifest: doubles.manifest }
  }
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: (args: { signal: AbortSignal }) =>
    new Promise<MobileWebBundleFetchResult>((resolve) => {
      doubles.fetches.push({ signal: args.signal, settle: resolve })
    })
}))

import { useMobileWebShellSession } from './use-mobile-web-shell-session'

const HOST_ID = 'host-1'
const DIRECTORY = 'file:///cache/mobile-web/host/generations/b'

function activeGeneration(): ActiveGeneration {
  return { buildId: doubles.manifest.buildId, directory: DIRECTORY, manifest: doubles.manifest }
}

function stagedGeneration(): StagedGeneration {
  return {
    hostKey: 'host-key',
    buildId: doubles.manifest.buildId,
    directory: DIRECTORY,
    manifest: doubles.manifest
  }
}

/** A store whose cache read is held open, so a test can decide when the answer arrives. */
function createFakeStore(): {
  store: GenerationStore
  settleCacheRead: Settle<ActiveGeneration | null>
  staged: () => number
  committed: () => number
} {
  let settleCacheRead: Settle<ActiveGeneration | null> = () => {}
  let staged = 0
  let committed = 0
  const store: GenerationStore = {
    readActiveGeneration: () =>
      new Promise<ActiveGeneration | null>((resolve) => {
        settleCacheRead = resolve
      }),
    stageGeneration: async () => {
      staged += 1
      return stagedGeneration()
    },
    commitGeneration: async () => {
      committed += 1
      return activeGeneration()
    },
    abortStagedGeneration: async () => undefined,
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined
  }
  return {
    store,
    settleCacheRead: (value) => settleCacheRead(value),
    staged: () => staged,
    committed: () => committed
  }
}

type Mounted = {
  tree: ReactTestRenderer
  retry: () => void
  rerender: () => void
}

async function mount(store: GenerationStore): Promise<Mounted> {
  const handle: { retry: () => void } = { retry: () => {} }
  function Probe() {
    const session = useMobileWebShellSession({
      hostId: HOST_ID,
      runtime: { createStore: () => store, mintSessionId: () => 'session-id', now: () => 0 }
    })
    handle.retry = session.retry
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
    tree,
    retry: () => handle.retry(),
    rerender: () => tree.update(createElement(Probe))
  }
}

async function flush(): Promise<void> {
  await act(async () => undefined)
}

describe('the hybrid shell runner', () => {
  beforeEach(() => {
    doubles.manifestReads = 0
    doubles.manifestClients.length = 0
    doubles.fetches.length = 0
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
  })

  it('abandons the cache read of a session that has been unmounted', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    await act(async () => {
      mounted.tree.unmount()
    })
    fake.settleCacheRead(null)
    await flush()
    // The read came back to nobody: had it been applied, the next effect would have asked the host
    // for a manifest on behalf of a screen that is gone.
    expect(doubles.manifestReads).toBe(0)
  })

  it('aborts the download an unmount interrupts, and never writes what it was pulling', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    expect(doubles.fetches).toHaveLength(1)
    const inFlight = doubles.fetches[0]
    if (inFlight === undefined) {
      throw new Error('no download was started')
    }
    await act(async () => {
      mounted.tree.unmount()
    })
    expect(inFlight.signal.aborted).toBe(true)
    inFlight.settle({
      manifest: doubles.manifest,
      assets: new Map(),
      totalBytes: 2048,
      elapsedMs: 1
    })
    await flush()
    expect(fake.staged()).toBe(0)
    expect(fake.committed()).toBe(0)
  })

  it('reads the manifest through the client the host has now, not the one it opened with', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    expect(doubles.manifestClients).toHaveLength(1)
    // A reconnect hands the screen a new client object with the same reachability, so nothing the
    // gates effect watches changes; only the next flow can show which one the runner kept.
    const reconnected = {}
    doubles.connection = { client: reconnected, state: 'connected' }
    await act(async () => {
      mounted.rerender()
    })
    await act(async () => {
      mounted.retry()
    })
    fake.settleCacheRead(null)
    await flush()
    expect(doubles.manifestClients.at(-1)).toBe(reconnected)
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('abandons the download still in flight when Try again starts a new one', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    const first = doubles.fetches[0]
    if (first === undefined) {
      throw new Error('no download was started')
    }
    await act(async () => {
      mounted.retry()
    })
    expect(first.signal.aborted).toBe(true)
    first.settle({ manifest: doubles.manifest, assets: new Map(), totalBytes: 2048, elapsedMs: 1 })
    await flush()
    expect(fake.staged()).toBe(0)
    await act(async () => {
      mounted.tree.unmount()
    })
  })
})
