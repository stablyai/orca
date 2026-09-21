import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type { ActiveGeneration, GenerationStore, StagedGeneration } from './generation-store'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

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
  manifestRejection: unknown
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
    ],
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
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
    manifestRejection: null,
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
    if (doubles.manifestRejection !== null) {
      throw doubles.manifestRejection
    }
    return { manifest: doubles.manifest }
  }
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: (args: { signal: AbortSignal }) =>
    new Promise<MobileWebBundleFetchResult>((resolve) => {
      doubles.fetches.push({ signal: args.signal, settle: resolve })
    })
}))

import { BRIDGE_READY_RETRY_MAX_MS } from './bridge/bridge-client-init-handshake'
import { PAGE_READY_DEADLINE_MS } from './mobile-web-shell-runtime'
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

/** A store whose cache read is held open, so a test can decide when the answer arrives. Staging can
 *  be held open too, which is the only way to stand inside the window between it and the commit. */
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
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined
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

/** Armed timers, never real ones: the deadline is ten seconds and a suite that waited for it would
 *  be a suite nobody runs. Each entry keeps its delay so the test can pin what was asked for. */
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
    /** Fires every timer still armed, in the order it was armed. */
    fire: (): void => {
      // A snapshot: firing one may arm another, and the new one is not part of this round.
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
  /** Whether the page had spoken, as every render of the hook reported it. */
  handshakes: () => readonly boolean[]
  documentLoaded: () => void
  pageReady: () => void
  timers: ReturnType<typeof createTimerSeam>
}

async function mount(store: GenerationStore): Promise<Mounted> {
  const timers = createTimerSeam()
  const handle: {
    retry: () => void
    documentLoaded: () => void
    pageReady: () => void
    states: MobileWebShellSessionState[]
    handshakes: boolean[]
  } = {
    retry: () => {},
    documentLoaded: () => {},
    pageReady: () => {},
    states: [],
    handshakes: []
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
    handle.documentLoaded = session.reportDocumentLoaded
    handle.pageReady = session.reportPageReady
    handle.states.push(session.state)
    handle.handshakes.push(session.pageReady)
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
    rerender: () => tree.update(createElement(Probe)),
    states: () => handle.states,
    handshakes: () => handle.handshakes,
    documentLoaded: () => handle.documentLoaded(),
    pageReady: () => handle.pageReady(),
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

  it('shows the cached workspace when the socket drops the manifest read it was waiting on', async () => {
    // The device repro: the rejection reaches the reducer before the reachability change does, so
    // the offline gate never fires and only the error's own marks say the link was what went.
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
    // The commit is the write the staging tree cannot undo: it renames into the active slot and
    // moves the host index, so a generation nobody asked for would be the one the next mount opens.
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

/**
 * The gap a blank page lives in.
 *
 * A route module that throws while the bundle is being evaluated takes the entry down with it: the
 * document still commits, the WebView still reports it loaded, and nothing downstream of that
 * import runs — so no boundary mounts, no fault is posted, and no frame is ever sent. Without a
 * clock the session sits in `ready` behind a WebView showing nothing, forever.
 */
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

  it(`waits out several of the page's own asks before it gives up on one`, () => {
    // The number the deadline is for: a page whose backoff has widened to the ceiling still gets
    // several asks inside the wait, so a slow device is never mistaken for a page that never ran.
    expect(PAGE_READY_DEADLINE_MS / BRIDGE_READY_RETRY_MAX_MS).toBe(5)
  })

  it('fails the generation a finished document never spoke for, and asks to fetch it again', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
    })
    expect(mounted.timers.armed.map((timer) => timer.delayMs)).toEqual([PAGE_READY_DEADLINE_MS])
    await act(async () => {
      mounted.timers.fire()
    })
    // Not the failure screen: `document-load-failed` on a session that has not retried deletes the
    // host's cache and runs the flow once more, which is the recovery a republished bundle needs.
    expect(mounted.states().at(-1)?.kind).toBe('checking')
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('stops the clock when the page speaks inside it, whichever of the two lands first', async () => {
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

  /**
   * The bridge host is rebuilt when the client under it changes and the page is never told, so it
   * takes "this session has handshaken" from here. It is a fact about the session, and a render is
   * the only thing that carries it to the mount that builds the next host.
   */
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
    // The race is real on a device: the page's first frame crosses the bridge while the WebView's
    // own load callback is still in the native queue.
    expect(mounted.timers.armed).toHaveLength(0)
    await act(async () => {
      mounted.tree.unmount()
    })
  })

  it('re-arms a session the route rebuilt, with the host and its gates unchanged', async () => {
    // The route is the other half of the session identity: changing it throws the old session away,
    // and a session nobody told the gates about never leaves `checking`.
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
      rendered.tree = create(createElement(Probe))
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
    // The rebuilt session must open the cache of its own accord; settling a read it never asked
    // for leaves it in `checking`, which is exactly what an un-armed session looks like.
    await act(async () => {
      fake.settleCacheRead(null)
    })
    await flush()
    // Pinned, not merely "moved on": `/h/host-1/tasks` is not the route the bundle lists, so a
    // re-armed session settles on the native screen. A failure would also leave `checking`.
    expect(seen.at(-1)?.kind).toBe('native-route')
    await act(async () => {
      tree.unmount()
    })
  })

  it('cancels the armed deadline when the session it belongs to is torn down', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.documentLoaded()
    })
    await act(async () => {
      mounted.tree.unmount()
    })
    // A real `setTimeout` outlives the screen; the epoch check makes it inert, and this makes it
    // not fire at all.
    expect(mounted.timers.armed.every((timer) => timer.cancelled)).toBe(true)
  })
})
