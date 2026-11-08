import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type {
  MobileWebBundleFetchProgress,
  MobileWebBundleFetchResult
} from '../transport/web-bundle/mobile-web-bundle-fetch'
import type { MobileWebBundleManifestRead } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type { ActiveGeneration, GenerationStore, StagedGeneration } from './generation-store'
import type { DownloadProgressFeed } from './download-progress-feed'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import '../transport/rpc/rpc-delivery-ambiguity'

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
  appState: {
    currentState: string
    listeners: Set<(state: string) => void>
  }
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
    manifest,
    appState: { currentState: 'active', listeners: new Set() }
  }
})

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined }
}))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return doubles.appState.currentState
    },
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      doubles.appState.listeners.add(listener)
      return { remove: () => doubles.appState.listeners.delete(listener) }
    }
  }
}))
vi.mock('../transport/encryption/mobile-session-id-encoding', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => doubles.gates
}))
vi.mock('../transport/connection/host-client-hooks', () => ({
  useHostClient: () => doubles.connection
}))
vi.mock('../transport/rpc/rpc-operation', () => ({
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
vi.mock('../transport/web-bundle/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: (args: {
    signal: AbortSignal
    onProgress: (progress: MobileWebBundleFetchProgress) => void
  }) =>
    new Promise<MobileWebBundleFetchResult>((resolve) => {
      doubles.fetches.push({ signal: args.signal, onProgress: args.onProgress, settle: resolve })
    })
}))

import './mobile-web-shell-runtime'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

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
  deferred: () => number
  aborted: () => number
  deleted: () => number
} {
  let settleCacheRead: Settle<ActiveGeneration | null> = () => {}
  let releaseStage: () => void = () => {}
  let heldStage = false
  let staged = 0
  let committed = 0
  let deferred = 0
  let aborted = 0
  let deleted = 0
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
    deferCommit: () => {
      deferred += 1
    },
    holdGeneration: () => () => {},
    claimUpdate: async () => () => {},
    abortStagedGeneration: async () => {
      aborted += 1
    },
    openReusableAssets: async () => ({ has: () => false, check: async () => false }),
    deleteHostCache: async () => {
      deleted += 1
    },
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
    deferred: () => deferred,
    aborted: () => aborted,
    deleted: () => deleted
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
  shellFailed: (reason: 'document-load-failed') => void
  downloadProgress: () => DownloadProgressFeed
  timers: ReturnType<typeof createTimerSeam>
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

async function mount(
  store: GenerationStore,
  setForegroundTimer?: MobileWebShellRuntime['setForegroundTimer']
): Promise<Mounted> {
  const timers = createTimerSeam()
  // Mint distinct ids so a remount's replacement view can be told from the one it retires.
  let minted = 0
  const handle: {
    retry: () => void
    documentStarted: () => void
    documentLoaded: () => void
    pageReady: () => void
    pagePainted: () => void
    shellFailed: (reason: 'document-load-failed') => void
    states: MobileWebShellSessionState[]
    handshakes: boolean[]
    downloadProgress: DownloadProgressFeed | null
  } = {
    retry: () => {},
    documentStarted: () => {},
    documentLoaded: () => {},
    pageReady: () => {},
    pagePainted: () => {},
    shellFailed: () => {},
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
        mintSessionId: () => `session-${++minted}`,
        now: () => 0,
        setForegroundTimer: setForegroundTimer ?? timers.setTimer
      }
    })
    handle.retry = session.retry
    handle.documentStarted = session.reportDocumentStarted
    handle.documentLoaded = session.reportDocumentLoaded
    handle.pageReady = session.reportPageReady
    handle.pagePainted = session.reportPagePainted
    handle.shellFailed = session.reportShellFailure
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
    shellFailed: (reason) => handle.shellFailed(reason),
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

  async function ready(fake = createFakeStore()): Promise<Mounted> {
    const mounted = await mount(fake.store)
    fake.settleCacheRead(activeGeneration())
    await flush()
    expect(mounted.states().at(-1)?.kind).toBe('ready')
    return mounted
  }

  // A remount mints the replacement's session before React commits it; reports the retired view already queued must not land on it.
  it('does not charge a second fault from the retired view to its replacement', async () => {
    const mounted = await ready()
    await act(async () => {
      mounted.shellFailed('document-load-failed')
      mounted.shellFailed('document-load-failed')
    })
    expect(mounted.states().at(-1)?.kind).toBe('ready')
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
          setForegroundTimer: createTimerSeam().setTimer
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
})

// RN holds timers while backgrounded and fires overdue ones on resume, before the suspended WebView has loaded anything.
