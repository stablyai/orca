import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type {
  MobileWebBundleFetchProgress,
  MobileWebBundleFetchResult
} from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { ActiveGeneration, GenerationStore, StagedGeneration } from './generation-store'
import type { DownloadProgressFeed } from './download-progress-feed'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

// Test effect abandonment, fetch aborts and retry wiring around the table-tested reducer; cancellation must free read slots and prevent writes for retired screens.
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
  manifestRejection: unknown
  fetches: {
    signal: AbortSignal
    onProgress: (progress: MobileWebBundleFetchProgress) => void
    settle: Settle<MobileWebBundleFetchResult>
  }[]
  manifest: MobileWebBundleManifestRead
}

const doubles = vi.hoisted((): Doubles => {
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
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
  }
  return {
    connection: { client: {}, state: 'connected' },
    gates: {
      statusPending: false,
      statusReadable: true,
      hostCapabilities: [],
      hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
    },
    manifestReads: 0,
    manifestClients: [],
    manifestRejection: null,
    fetches: [],
    manifest
  }
})

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined }
}))
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
  runRpcOperation: async (client: unknown) => {
    doubles.manifestReads += 1
    doubles.manifestClients.push(client)
    if (doubles.manifestRejection !== null) {
      throw doubles.manifestRejection
    }
    return { manifest: doubles.manifest }
  }
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: (args: {
    signal: AbortSignal
    onProgress: (progress: MobileWebBundleFetchProgress) => void
  }) =>
    new Promise<MobileWebBundleFetchResult>((resolve) => {
      doubles.fetches.push({ signal: args.signal, onProgress: args.onProgress, settle: resolve })
    })
}))

import { DOCUMENT_LOAD_DEADLINE_MS, PAGE_READY_DEADLINE_MS } from './mobile-web-shell-runtime'
import { SHELL_STALL_LOG_MS } from './shell-lifecycle-log'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
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

// Hold cache/stage reads so tests can place cancellation between staging and irreversible commit.
function createFakeStore(): {
  store: GenerationStore
  settleCacheRead: Settle<ActiveGeneration | null>
  holdStage: () => void
  settleStage: () => void
  staged: () => number
  committed: () => number
  aborted: () => number
} {
  let settleCacheRead: Settle<ActiveGeneration | null> = () => {}
  let releaseStage: () => void = () => {}
  let heldStage = false
  let staged = 0
  let committed = 0
  let aborted = 0
  const store: GenerationStore = {
    readActiveGeneration: () =>
      new Promise<ActiveGeneration | null>((resolve) => {
        settleCacheRead = resolve
      }),
    stageGeneration: async () => {
      staged += 1
      if (heldStage) {
        await new Promise<void>((resolve) => {
          releaseStage = resolve
        })
      }
      return stagedGeneration()
    },
    commitGeneration: async () => {
      committed += 1
      return activeGeneration()
    },
    abortStagedGeneration: async () => {
      aborted += 1
    },
    openReusableAssets: async () => ({ has: () => false, check: async () => false }),
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined,
    recordUpdateFailure: async () => undefined,
    readUpdateFailures: async () => [],
    forgetHostUpdateFailures: async () => undefined
  }
  return {
    store,
    settleCacheRead: (value) => settleCacheRead(value),
    holdStage: () => {
      heldStage = true
    },
    settleStage: () => releaseStage(),
    staged: () => staged,
    committed: () => committed,
    aborted: () => aborted
  }
}

// Use recorded timers so deadline tests assert requested delays without wall-clock waits.
type ArmedTimer = { delayMs: number; run: () => void; cancelled: boolean }

function createTimerSeam() {
  const armed: ArmedTimer[] = []
  return {
    armed,
    setTimer: (run: () => void, delayMs: number): (() => void) => {
      const timer: ArmedTimer = { delayMs, run, cancelled: false }
      armed.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    fire: (): void => {
      // Fire a snapshot so timers armed by callbacks wait until the next round.
      const round = armed.slice()
      for (const timer of round) {
        if (!timer.cancelled) {
          timer.run()
        }
      }
    }
  }
}

type Mounted = {
  tree: ReactTestRenderer
  retry: () => void
  rerender: () => void
  states: () => readonly MobileWebShellSessionState[]
  handshakes: () => readonly boolean[]
  documentStarted: () => void
  documentLoaded: () => void
  pageReady: () => void
  pagePainted: () => void
  downloadProgress: () => DownloadProgressFeed
  timers: ReturnType<typeof createTimerSeam>
}

function live(timers: readonly ArmedTimer[]): ArmedTimer[] {
  return timers.filter((timer) => !timer.cancelled)
}

const mountedTrees: ReturnType<typeof create>[] = []

function createTracked(element: Parameters<typeof create>[0]): ReturnType<typeof create> {
  const tree = create(element)
  mountedTrees.push(tree)
  return tree
}

afterEach(async () => {
  await act(async () => {
    for (const tree of mountedTrees.splice(0)) {
      tree.unmount()
    }
  })
})

async function mount(store: GenerationStore): Promise<Mounted> {
  const timers = createTimerSeam()
  const handle: {
    retry: () => void
    documentStarted: () => void
    documentLoaded: () => void
    pageReady: () => void
    pagePainted: () => void
    states: MobileWebShellSessionState[]
    handshakes: boolean[]
    downloadProgress: DownloadProgressFeed | null
  } = {
    retry: () => {},
    documentStarted: () => {},
    documentLoaded: () => {},
    pageReady: () => {},
    pagePainted: () => {},
    states: [],
    handshakes: [],
    downloadProgress: null
  }
  function Probe() {
    const session = useMobileWebShellSession({
      hostId: HOST_ID,
      routePathname: '/h/host-1',
      runtime: {
        createStore: () => store,
        mintSessionId: () => 'session-id',
        now: () => 0,
        setTimer: timers.setTimer
      }
    })
    handle.retry = session.retry
    handle.documentStarted = session.reportDocumentStarted
    handle.documentLoaded = session.reportDocumentLoaded
    handle.pageReady = session.reportPageReady
    handle.pagePainted = session.reportPagePainted
    handle.states.push(session.state)
    handle.handshakes.push(session.pageReady)
    handle.downloadProgress = session.downloadProgress
    return null
  }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = createTracked(createElement(Probe))
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the hook did not mount')
  }
  return {
    tree,
    retry: () => handle.retry(),
    rerender: () => tree.update(createElement(Probe)),
    states: () => handle.states,
    handshakes: () => handle.handshakes,
    documentStarted: () => handle.documentStarted(),
    documentLoaded: () => handle.documentLoaded(),
    pageReady: () => handle.pageReady(),
    pagePainted: () => handle.pagePainted(),
    downloadProgress: () => {
      if (handle.downloadProgress === null) {
        throw new Error('the hook never rendered')
      }
      return handle.downloadProgress
    },
    timers
  }
}

async function flush(): Promise<void> {
  await act(async () => undefined)
}

describe('the hybrid shell runner', () => {
  beforeEach(() => {
    doubles.manifestReads = 0
    doubles.manifestClients.length = 0
    doubles.manifestRejection = null
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
      reused: [],
      totalBytes: 2048,
      elapsedMs: 1
    })
    await flush()
    expect(fake.staged()).toBe(0)
    expect(fake.committed()).toBe(0)
  })

  it('shows the cached workspace when the socket drops the manifest read it was waiting on', async () => {
    // Reject before reachability changes to prove error classification alone can recognize link loss.
    doubles.manifestRejection = markRpcDeliveryUnknown(new Error('Connection interrupted'))
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(activeGeneration())
    await flush()

    expect(doubles.manifestReads).toBe(1)
    expect(doubles.fetches).toHaveLength(0)
    expect(mounted.states().map((state) => state.kind)).toContain('ready')
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('takes the staged tree back out when the unmount lands between staging and the commit', async () => {
    const fake = createFakeStore()
    fake.holdStage()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    const inFlight = doubles.fetches[0]
    if (inFlight === undefined) {
      throw new Error('no download was started')
    }
    inFlight.settle({
      manifest: doubles.manifest,
      assets: new Map(),
      reused: [],
      totalBytes: 2048,
      elapsedMs: 1
    })
    await flush()
    expect(fake.staged()).toBe(1)

    await act(async () => {
      mounted.tree.unmount()
    })
    await act(async () => {
      fake.settleStage()
    })
    // Commit cannot be undone by aborting tmp; a stray activation would become the next mount’s cache.
    expect(fake.committed()).toBe(0)
    expect(fake.aborted()).toBe(1)
    expect(mounted.states().map((state) => state.kind)).not.toContain('ready')
  })

  it('reads the manifest through the client the host has now, not the one it opened with', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    expect(doubles.manifestClients).toHaveLength(1)
    // Keep reachability unchanged while replacing the client; only the next flow reveals which client the runner retained.
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

  it('moves the download feed as progress is dispatched, without waiting for a render', async () => {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(null)
    await flush()
    const fetch = doubles.fetches[0]
    if (fetch === undefined) {
      throw new Error('no download was started')
    }
    const heard: number[] = []
    mounted.downloadProgress().subscribe((fraction) => heard.push(fraction))
    const renders = mounted.states().length
    fetch.onProgress({ completedAssets: 0, totalAssets: 2, receivedBytes: 1024, totalBytes: 4096 })
    fetch.onProgress({ completedAssets: 1, totalAssets: 2, receivedBytes: 4096, totalBytes: 4096 })
    expect(heard).toEqual([0.25, 1])
    expect(mounted.states()).toHaveLength(renders)
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
    first.settle({
      manifest: doubles.manifest,
      assets: new Map(),
      reused: [],
      totalBytes: 2048,
      elapsedMs: 1
    })
    await flush()
    expect(fake.staged()).toBe(0)
    await act(async () => {
      mounted.tree.unmount()
    })
  })
})

// Entry import failures can finish WebView load without mounting a boundary or sending ready; the deadline must recover that silent blank page.
describe('the wait for the page to speak', () => {
  beforeEach(() => {
    doubles.manifestReads = 0
    doubles.manifestClients.length = 0
    doubles.manifestRejection = null
    doubles.fetches.length = 0
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
  })

  async function ready(): Promise<Mounted> {
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    fake.settleCacheRead(activeGeneration())
    await flush()
    expect(mounted.states().at(-1)?.kind).toBe('ready')
    return mounted
  }

  it('fails the generation a finished document never spoke for, and asks to fetch it again', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
    })
    expect(live(mounted.timers.armed).map((timer) => timer.delayMs)).toEqual([
      DOCUMENT_LOAD_DEADLINE_MS,
      SHELL_STALL_LOG_MS,
      PAGE_READY_DEADLINE_MS
    ])
    await act(async () => {
      mounted.timers.fire()
    })
    expect(mounted.states().at(-1)?.kind).toBe('checking')
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('fails a generation whose document the view never finished, instead of spinning forever', async () => {
    // iOS 18 can refuse its own document load without any failure callback (#28626).
    const mounted = await ready()
    await act(async () => {
      mounted.documentStarted()
    })
    expect(
      live(mounted.timers.armed).filter((timer) => timer.delayMs === DOCUMENT_LOAD_DEADLINE_MS)
    ).toHaveLength(1)
    await act(async () => {
      mounted.timers.fire()
    })
    expect(mounted.states().at(-1)?.kind).toBe('checking')
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('stays ready when the page speaks after document load and the timers fire', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
      mounted.pageReady()
    })
    await act(async () => {
      mounted.timers.fire()
    })
    expect(mounted.states().at(-1)?.kind).toBe('ready')
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('reports the handshake the page completed, for the host that is rebuilt over it', async () => {
    const mounted = await ready()
    expect(mounted.handshakes().at(-1)).toBe(false)
    await act(async () => {
      mounted.pageReady()
    })
    expect(mounted.handshakes().at(-1)).toBe(true)
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('arms nothing when the page spoke before the document was reported finished', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.pageReady()
      mounted.documentLoaded()
    })
    // Page ready can cross before the native WebView load callback; accept either order.
    expect(
      mounted.timers.armed.filter((timer) => timer.delayMs === PAGE_READY_DEADLINE_MS)
    ).toEqual([])
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('re-arms a session the route rebuilt, with the host and its gates unchanged', async () => {
    // A route change rebuilds the session too; re-arm gates even if their verdict did not change.
    const fake = createFakeStore()
    const route = { pathname: '/h/host-1' }
    const seen: MobileWebShellSessionState[] = []
    function Probe() {
      const session = useMobileWebShellSession({
        hostId: HOST_ID,
        routePathname: route.pathname,
        runtime: {
          createStore: () => fake.store,
          mintSessionId: () => 'session-id',
          now: () => 0,
          setTimer: createTimerSeam().setTimer
        }
      })
      seen.push(session.state)
      return null
    }
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = createTracked(createElement(Probe))
    })
    const tree = rendered.tree
    if (tree === null) {
      throw new Error('the hook did not mount')
    }
    await act(async () => {
      fake.settleCacheRead(null)
    })
    route.pathname = '/h/host-1/tasks'
    seen.length = 0
    await act(async () => {
      tree.update(createElement(Probe))
    })
    await act(async () => {
      fake.settleCacheRead(null)
    })
    await flush()
    // Assert the expected wall: any failure could leave checking without proving the new route was evaluated.
    expect(seen.at(-1)).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'page-route-unlisted' }
    })
    await act(async () => {
      tree.unmount()
    })
  })

  it('logs one stall warning for a page that never draws, without moving the session', async () => {
    const logged = () => connectionLogStore.get(HOST_ID)
    const before = logged().length
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
      mounted.pageReady()
    })
    const stallTimers = live(mounted.timers.armed).filter(
      (timer) => timer.delayMs === SHELL_STALL_LOG_MS
    )
    expect(stallTimers).toHaveLength(1)
    await act(async () => {
      stallTimers[0]?.run()
    })
    expect(mounted.states().at(-1)?.kind).toBe('ready')
    expect(logged().slice(before)).toEqual([
      expect.objectContaining({
        message: 'Web shell: page has not drawn after 15s',
        detail: expect.stringContaining('page ready=yes readyAsks=1 documentLoaded=yes')
      })
    ])
  })

  it('writes one line for a healthy open, on paint', async () => {
    const before = connectionLogStore.get(HOST_ID).length
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
      mounted.pageReady()
      mounted.pagePainted()
    })
    expect(
      connectionLogStore
        .get(HOST_ID)
        .slice(before)
        .map((entry) => `${entry.message} | ${entry.detail}`)
    ).toEqual([expect.stringMatching(/^Web shell: page painted \| source=cache build=\S{1,8} /)])
    expect(live(mounted.timers.armed).filter((t) => t.delayMs === SHELL_STALL_LOG_MS)).toEqual([])
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it("logs a stall for the first open's checking state, which no transition line covers", async () => {
    const before = connectionLogStore.get(HOST_ID).length
    const fake = createFakeStore()
    const mounted = await mount(fake.store)
    expect(mounted.states().at(-1)?.kind).toBe('checking')
    const stallTimers = live(mounted.timers.armed).filter(
      (timer) => timer.delayMs === SHELL_STALL_LOG_MS
    )
    expect(stallTimers).toHaveLength(1)
    await act(async () => {
      stallTimers[0]?.run()
    })
    expect(connectionLogStore.get(HOST_ID).slice(before)).toEqual([
      expect.objectContaining({
        message: 'Web shell: still checking host after 15s',
        detail: 'gates=open cache=unread'
      })
    ])
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('cancels the armed deadline when the session it belongs to is torn down', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
    })
    expect(
      live(mounted.timers.armed).filter((timer) => timer.delayMs === PAGE_READY_DEADLINE_MS)
    ).toHaveLength(1)
    await act(async () => {
      mounted.tree.unmount()
    })
    // Cancel real timers on unmount as well as rejecting their results by epoch.
    expect(mounted.timers.armed.every((timer) => timer.cancelled)).toBe(true)
  })
})
