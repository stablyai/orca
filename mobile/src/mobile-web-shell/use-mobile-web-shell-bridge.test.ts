import {
  createElement,
  useImperativeHandle,
  useLayoutEffect,
  useState,
  type ReactElement
} from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge/bridge-native-verbs'
import {
  BRIDGE_HAPTICS_GRANT,
  BRIDGE_HAPTICS_NOTIFY,
  type BridgeHapticsKind
} from './bridge/bridge-haptics-notify'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'
import { BRIDGE_BACK_CLAIM_NOTIFY, BRIDGE_BACK_FRAME } from './bridge/bridge-page-back'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  readBridgeHostMessage,
  type BridgeHostMessage
} from './bridge/bridge-envelope'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { FakeRpcClient } from './bridge-host-test-fakes'

const doubles = vi.hoisted((): { client: FakeRpcClient | null } => ({ client: null }))

// Stub Expo-dependent client lookup; the hook reads only identity.
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: doubles.client })
}))

import {
  bridgeId,
  clientFrame,
  createFakeRpcClient,
  flushBridge,
  rpcSuccess
} from './bridge-host-test-fakes'
import {
  useMobileWebShellBridge,
  type MobileWebShellBridgeView
} from './use-mobile-web-shell-bridge'
import { connectionLogStore } from '../transport/persisted-connection-log-store'

const ID = bridgeId(1)
const DIRECTORY = '/caches/mobile-web/deadbeef/generations/a1b2'

type PostedFrame = { sessionId: string; json: string }

type Probe = {
  view: MobileWebShellBridgeView | null
  navigations: string[]
  externalLinks: string[]
  haptics: BridgeHapticsKind[]
  backPops: number
  storageWrites: { key: string; value: string | null }[]
  droppedBinaryFrames: number[]
  paints: number
  backClaims: boolean[]
}

const SNAPSHOT = {
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 7 }
}

const STORAGE = { 'orca:pins:host-1': '["wt-1"]' }

function fakeClient(): FakeRpcClient {
  const client = doubles.client
  if (client === null) {
    throw new Error('this test has no client')
  }
  return client
}

function FakeShellView(props: {
  sessionId: string
  viewRef: (handle: OrcaMobileWebShellViewHandle | null) => void
  posted: PostedFrame[]
}): null {
  useImperativeHandle(
    props.viewRef,
    () => ({
      postBridgeMessage: (json: string) => {
        props.posted.push({ sessionId: props.sessionId, json })
        return Promise.resolve()
      }
    }),
    [props.posted, props.sessionId]
  )
  return null
}

// Deliver from the parent layout effect after hook commit work but before passive effects, matching the native-message race window.
function DeliverDuringCommit(props: {
  deliver: readonly string[]
  posted: PostedFrame[]
  probe: Probe
  faults: BridgeErrorCapture[]
  readies: string[]
}): ReactElement {
  const { deliver, probe } = props
  useLayoutEffect(() => {
    for (const json of deliver) {
      probe.view?.onBridgeMessage({ nativeEvent: { json } })
    }
  }, [deliver, probe])
  return createElement(Harness, {
    session: readyState('session-one'),
    posted: props.posted,
    probe,
    faults: props.faults,
    readies: props.readies
  })
}

function Harness(props: {
  session: MobileWebShellSessionState
  sessionEstablished?: boolean
  posted: PostedFrame[]
  probe: Probe
  faults: BridgeErrorCapture[]
  readies: string[]
}): ReactElement | null {
  const [handshook, setHandshook] = useState<string | null>(null)
  const sessionId = props.session.kind === 'ready' ? props.session.sessionId : null
  const view = useMobileWebShellBridge({
    hostId: 'host-1',
    session: props.session,
    sessionEstablished: props.sessionEstablished ?? (sessionId !== null && handshook === sessionId),
    route: { pathname: '/h/host-1' },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboardInset: 0,
    foldDivision: null,
    pageGeometry: { occlusions: [], sideRail: false },
    terminalKeyRail: [],
    colorScheme: 'dark',
    uiLocale: 'en',
    pageRoutes: ['/h/[hostId]'],
    pageRouteGrants: [{ pathname: '/h/[hostId]', grants: ['navigate', 'storage'] }],
    routeGrants: [
      'navigate',
      'storage',
      'externalLink',
      BRIDGE_HAPTICS_GRANT,
      BRIDGE_SCREENCAST_BINARY_GRANT,
      ...BRIDGE_NATIVE_VERB_NAMES
    ],
    onNavigate: (href) => props.probe.navigations.push(href),
    onExternalLink: (url) => props.probe.externalLinks.push(url),
    onHaptic: (kind) => props.probe.haptics.push(kind),
    serveNativeVerb: () => Promise.resolve({ value: 'pasteboard' }),
    onNavigateBack: () => {
      props.probe.backPops += 1
      return 'popped'
    },
    snapshot: SNAPSHOT,
    readStorage: () => ({ storage: STORAGE, storageOversize: [] }),
    onStorageWrite: (key, value) => props.probe.storageWrites.push({ key, value }),
    // Use fresh callbacks each render; rebuilding for them would settle pending requests.
    onPageFault: (error) => props.faults.push(error),
    onRouteRefused: () => {},
    onRouteParamClear: () => {},
    onBinaryFramesDropped: (total) => props.probe.droppedBinaryFrames.push(total),
    onPageReady: () => {
      setHandshook(sessionId)
      props.readies.push(sessionId ?? props.session.kind)
    },
    onPagePainted: () => {
      props.probe.paints += 1
    },
    onPageBackClaim: (claimed) => props.probe.backClaims.push(claimed),
    onPageLocation: () => {},
    onTerminalKeyRailClaim: () => {}
  })
  props.probe.view = view
  return props.session.kind === 'ready'
    ? createElement(FakeShellView, {
        key: props.session.sessionId,
        sessionId: props.session.sessionId,
        viewRef: view.viewRef,
        posted: props.posted
      })
    : null
}

function readyState(sessionId: string): MobileWebShellSessionState {
  return {
    kind: 'ready',
    generationDirectory: DIRECTORY,
    sessionId,
    buildId: 'build-a',
    totalBytes: 4096,
    elapsedMs: 11
  }
}

type Mounted = {
  tree: ReactTestRenderer
  posted: PostedFrame[]
  probe: Probe
  faults: BridgeErrorCapture[]
  readies: string[]
  update: (session: MobileWebShellSessionState) => Promise<void>
  deliver: (json: string) => Promise<void>
  frames: (sessionId: string) => BridgeHostMessage[]
}

let warned: MockInstance<typeof console.warn>

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
  vi.restoreAllMocks()
})

async function mount(
  session: MobileWebShellSessionState,
  sessionEstablished?: boolean
): Promise<Mounted> {
  const posted: PostedFrame[] = []
  const probe: Probe = {
    view: null,
    navigations: [],
    externalLinks: [],
    haptics: [],
    backPops: 0,
    droppedBinaryFrames: [],
    paints: 0,
    backClaims: [],
    storageWrites: []
  }
  const faults: BridgeErrorCapture[] = []
  const readies: string[] = []
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  const render = (next: MobileWebShellSessionState): ReactElement =>
    createElement(Harness, {
      session: next,
      ...(sessionEstablished === undefined ? {} : { sessionEstablished }),
      posted,
      probe,
      faults,
      readies
    })
  await act(async () => {
    rendered.tree = createTracked(render(session))
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the harness did not render')
  }
  return {
    tree,
    posted,
    probe,
    faults,
    readies,
    update: async (next) => {
      await act(async () => {
        tree.update(render(next))
      })
    },
    deliver: async (json) => {
      await act(async () => {
        probe.view?.onBridgeMessage({ nativeEvent: { json } })
      })
    },
    frames: (sessionId) =>
      posted
        .filter((frame) => frame.sessionId === sessionId)
        .map((frame) => {
          const read = readBridgeHostMessage(frame.json)
          if (!read.ok) {
            throw new Error(`the page would refuse this frame: ${read.refusal}`)
          }
          return read.message
        })
  }
}

beforeEach(() => {
  doubles.client = createFakeRpcClient()
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('the bridge channel', () => {
  it('is closed until the session is ready and opens with it', async () => {
    const mounted = await mount({ kind: 'checking' })
    expect(mounted.probe.view?.bridgeEnabled).toBe(false)
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.posted).toEqual([])
    await mounted.update(readyState('session-one'))
    expect(mounted.probe.view?.bridgeEnabled).toBe(true)
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.frames('session-one')).toEqual([
      expect.objectContaining({ type: 'init', sessionId: 'session-one', buildId: 'build-a' })
    ])
  })

  it('names the screen the page stands in for, so its document at `/` is not what it opens', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.frames('session-one')).toEqual([
      expect.objectContaining({
        type: 'init',
        route: { pathname: '/h/host-1' },
        pageRoutes: ['/h/[hostId]'],
        host: SNAPSHOT.host,
        storage: STORAGE
      })
    ])
  })

  it('opens a screen the page hands back, through the caller that owns the stack', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-1/session/wt-1' })
    )
    expect(mounted.probe.navigations).toEqual(['/h/host-1/session/wt-1'])
  })

  it("hands the page's first paint to the caller that owns the cover over the view", async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.probe.paints).toBe(0)
    await mounted.deliver(clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }))
    expect(mounted.probe.paints).toBe(1)
  })

  it('hands a URL the page asked for to the caller that can leave the app', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({ type: 'notify', name: 'externalLink', url: 'https://example.com/x' })
    )
    expect(mounted.probe.externalLinks).toEqual(['https://example.com/x'])
    expect(mounted.probe.navigations).toEqual([])
  })

  it('pops the stack the page was pushed onto, through the caller that owns it', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }))
    expect(mounted.probe.backPops).toBe(1)
    expect(mounted.probe.navigations).toEqual([])
  })

  it('does not rebuild the host for a route object the caller built again', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests.map((request) => request.method)).toEqual(['status.get'])
    // Fresh same-session route objects must not rebuild the host and settle this pending request.
    await mounted.update(readyState('session-one'))
    expect(mounted.frames('session-one').filter((frame) => frame.type === 'error')).toEqual([])
    fakeClient().requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(mounted.frames('session-one').filter((frame) => frame.type !== 'init')).toEqual([
      { v: 1, type: 'reply', id: ID, payload: rpcSuccess('wire-1', 'ok') }
    ])
  })

  it('hands a page fault to the screen and asks the client for nothing', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
      })
    )
    expect(mounted.faults).toEqual([
      { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    ])
    expect(fakeClient().requests).toEqual([])
  })

  it('reports a fault from the page on screen, never from the one it replaced', async () => {
    const mounted = await mount(readyState('session-one'))
    const stale = mounted.probe.view
    await mounted.update(readyState('session-two'))
    // Handshake first so the session fence, not missing grants, rejects the stale frame.
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await act(async () => {
      stale?.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'notify',
            name: BRIDGE_FAULT_GRANT,
            error: { category: 'Error', message: 'a dead page', isRpcDeliveryUnknown: false }
          })
        }
      })
    })
    expect(mounted.faults).toEqual([])
  })

  it('forwards to the client the hook was given', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('builds no host while the ready session has no client, and answers nothing', async () => {
    doubles.client = null
    const mounted = await mount(readyState('session-one'))
    expect(mounted.probe.view?.bridgeEnabled).toBe(true)
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.posted).toEqual([])
  })

  it('logs a frame it dropped for want of a host once per session, naming what is missing', async () => {
    doubles.client = null
    const dropped = () =>
      connectionLogStore
        .get('host-1')
        .filter((entry) => entry.message === 'Web shell: page frame with no bridge host')
    const before = dropped().length
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(dropped().slice(before)).toEqual([
      expect.objectContaining({ detail: 'client=null snapshot=ok' })
    ])
    await mounted.update(readyState('session-two'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(dropped().slice(before)).toHaveLength(2)
  })
})

describe('teardown', () => {
  it('posts a retiring session nothing into the page that replaced it', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests.map((request) => request.method)).toEqual(['status.get'])
    expect(warned).not.toHaveBeenCalled()
    await mounted.update(readyState('session-two'))
    expect(mounted.frames('session-two')).toEqual([])
    expect(warned).toHaveBeenCalledTimes(1)
    fakeClient().requests[0]?.resolve(rpcSuccess('wire-1', 'late'))
    await flushBridge()
    expect(mounted.frames('session-two')).toEqual([])
  })

  it(`routes the next session's frames to the next host`, async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.update(readyState('session-two'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.frames('session-two')).toEqual([
      expect.objectContaining({ type: 'init', sessionId: 'session-two' })
    ])
  })

  it('disposes when the session leaves ready, and answers nothing after', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'subscribe', id: ID, method: 'x.sub', params: {} }))
    await mounted.update({ kind: 'failed', reason: 'render-process-gone', retriedOnce: false })
    expect(fakeClient().streams[0]?.unsubscribes).toBe(1)
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.frames('session-one').filter((frame) => frame.type !== 'init')).toEqual([])
    expect(fakeClient().requests).toEqual([])
  })

  it('carries the dropped-frame total from the host to the screen', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({
        type: 'subscribe',
        id: ID,
        method: 'browser.screencast',
        params: {},
        wantsBinary: true
      })
    )
    const oversized = {
      opcode: 1 as const,
      seq: 1,
      format: 'jpeg' as const,
      metadata: {},
      image: new Uint8Array(500_000)
    }
    await act(async () => {
      fakeClient().streams[0]?.emitBinary?.(oversized)
      fakeClient().streams[0]?.emitBinary?.({ ...oversized, seq: 2 })
    })
    expect(mounted.probe.droppedBinaryFrames).toEqual([0, 1, 2])
    expect(fakeClient().streams[0]?.unsubscribes).toBe(0)
  })

  // Reset drop counts with host ownership so the next host’s first drop cannot look like recovered frames.
  it('resets the dropped-frame total when the host is rebuilt', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({
        type: 'subscribe',
        id: ID,
        method: 'browser.screencast',
        params: {},
        wantsBinary: true
      })
    )
    await act(async () => {
      fakeClient().streams[0]?.emitBinary?.({
        opcode: 1 as const,
        seq: 1,
        format: 'jpeg' as const,
        metadata: {},
        image: new Uint8Array(500_000)
      })
    })
    expect(mounted.probe.droppedBinaryFrames).toEqual([0, 1])
    await mounted.update(readyState('session-two'))
    expect(mounted.probe.droppedBinaryFrames).toEqual([0, 1, 0])
  })

  it('disposes on unmount and settles what was in flight as delivery-unknown', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await act(async () => {
      mounted.tree.unmount()
    })
    // Teardown while the old view is attached so its pending request receives a terminal result.
    expect(mounted.frames('session-one').filter((frame) => frame.type !== 'init')).toEqual([
      expect.objectContaining({
        type: 'error',
        id: ID,
        error: expect.objectContaining({
          category: 'BridgeHostDisposedError',
          code: 'bridge_host_disposed',
          isRpcDeliveryUnknown: true
        })
      })
    ])
    expect(warned).not.toHaveBeenCalled()
    fakeClient().requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(mounted.posted).toHaveLength(2)
  })

  it('ignores a frame that arrives for a session the hook has moved past', async () => {
    const mounted = await mount(readyState('session-one'))
    const stale = mounted.probe.view
    await mounted.update(readyState('session-two'))
    await act(async () => {
      stale?.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    })
    expect(mounted.posted).toEqual([])
  })
})

describe('diagnostics', () => {
  it('warns once for the frames one page has refused, not once each', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver('{"v":1,"type":')
    await mounted.deliver(clientFrame({ type: 'request', id: 'short', method: 'x' }))
    expect(warned).toHaveBeenCalledTimes(1)
  })

  it('names the notification it refused and why, rather than blaming the view', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'too early', isRpcDeliveryUnknown: false }
      })
    )
    expect(mounted.faults).toEqual([])
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('refused a page notification'), {
      name: BRIDGE_FAULT_GRANT,
      why: 'before-ready'
    })
  })

  it('starts the count over for the next page', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver('{"v":1,"type":')
    await mounted.update(readyState('session-two'))
    await mounted.deliver('{"v":1,"type":')
    expect(warned).toHaveBeenCalledTimes(2)
  })
})

describe('client changes', () => {
  it('rebuilds the host on a new client, so nothing crosses to the one that was replaced', async () => {
    const first = fakeClient()
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    const next = createFakeRpcClient()
    doubles.client = next
    await mounted.update(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(next.requests).toHaveLength(1)
    expect(first.requests).toHaveLength(0)
  })

  // Client replacement preserves the live document/session; retain its Back state so an open sheet cannot lose the next press.
  it('keeps delivering Back to an open sheet after the host is rebuilt under it', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({ type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: true })
    )
    expect(mounted.probe.backClaims).toEqual([true])
    // Replace only the client; no new document/ready should be required.
    doubles.client = createFakeRpcClient()
    await mounted.update(readyState('session-one'))
    expect(mounted.probe.backClaims).toEqual([true])
    const before = mounted.frames('session-one').length
    await act(async () => {
      expect(mounted.probe.view?.sendBack()).toBe(true)
    })
    expect(mounted.frames('session-one').slice(before)).toEqual([{ v: 1, type: BRIDGE_BACK_FRAME }])
  })

  it('drops the carried claim when the next document says ready', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(
      clientFrame({ type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: true })
    )
    doubles.client = createFakeRpcClient()
    await mounted.update(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.probe.backClaims).toEqual([true, false])
  })

  it('hands the host over in the commit, so no frame reaches the replaced client', async () => {
    const first = fakeClient()
    const posted: PostedFrame[] = []
    const probe: Probe = {
      view: null,
      navigations: [],
      externalLinks: [],
      haptics: [],
      backPops: 0,
      droppedBinaryFrames: [],
      paints: 0,
      backClaims: [],
      storageWrites: []
    }
    const render = (deliver: readonly string[]): ReactElement =>
      createElement(DeliverDuringCommit, { deliver, posted, probe, faults: [], readies: [] })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = createTracked(render([]))
    })
    const next = createFakeRpcClient()
    doubles.client = next
    // Same-session client replacement bypasses the session-id fence; only commit-phase host replacement keeps this frame off the retired client.
    await act(async () => {
      rendered.tree?.update(
        render([
          clientFrame({ type: 'ready' }),
          clientFrame({ type: 'request', id: ID, method: 'status.get' })
        ])
      )
    })
    expect(first.requests).toHaveLength(0)
    expect(next.requests).toHaveLength(1)
  })
})

function newProbe(): Probe {
  return {
    view: null,
    navigations: [],
    externalLinks: [],
    haptics: [],
    backPops: 0,
    droppedBinaryFrames: [],
    paints: 0,
    backClaims: [],
    storageWrites: []
  }
}

describe('the props one render passed', () => {
  // Verify callback freshness without host rebuild: pending requests stay open and drop totals announce once.
  it('routes each of them into the latest render, without rebuilding the host', async () => {
    const posted: PostedFrame[] = []
    const first = newProbe()
    const second = newProbe()
    const firstFaults: BridgeErrorCapture[] = []
    const secondFaults: BridgeErrorCapture[] = []
    const firstReadies: string[] = []
    const secondReadies: string[] = []
    const render = (probe: Probe, faults: BridgeErrorCapture[], readies: string[]): ReactElement =>
      createElement(Harness, { session: readyState('session-one'), posted, probe, faults, readies })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = createTracked(render(first, firstFaults, firstReadies))
    })
    const deliver = async (probe: Probe, json: string): Promise<void> => {
      await act(async () => {
        probe.view?.onBridgeMessage({ nativeEvent: { json } })
      })
    }
    await deliver(first, clientFrame({ type: 'ready' }))
    await deliver(first, clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests.map((request) => request.method)).toEqual(['status.get'])
    await act(async () => {
      rendered.tree?.update(render(second, secondFaults, secondReadies))
    })
    for (const json of [
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-1/session/wt-2' }),
      clientFrame({ type: 'notify', name: 'externalLink', url: 'https://example.com/y' }),
      clientFrame({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind: 'selection' }),
      clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }),
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:host-1', value: '["wt-2"]' }),
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
      }),
      clientFrame({ type: 'ready' })
    ]) {
      await deliver(second, json)
    }
    expect({
      navigations: first.navigations,
      externalLinks: first.externalLinks,
      haptics: first.haptics,
      backPops: first.backPops,
      storageWrites: first.storageWrites,
      faults: firstFaults,
      readies: firstReadies
    }).toEqual({
      navigations: [],
      externalLinks: [],
      haptics: [],
      backPops: 0,
      storageWrites: [],
      faults: [],
      readies: ['session-one']
    })
    expect({
      navigations: second.navigations,
      externalLinks: second.externalLinks,
      haptics: second.haptics,
      backPops: second.backPops,
      storageWrites: second.storageWrites,
      faults: secondFaults,
      readies: secondReadies
    }).toEqual({
      navigations: ['/h/host-1/session/wt-2'],
      externalLinks: ['https://example.com/y'],
      haptics: ['selection'],
      backPops: 1,
      storageWrites: [{ key: 'orca:pins:host-1', value: '["wt-2"]' }],
      faults: [{ category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }],
      readies: ['session-one']
    })
    const answered = posted.map((frame) => {
      const read = readBridgeHostMessage(frame.json)
      if (!read.ok) {
        throw new Error(`the page would refuse this frame: ${read.refusal}`)
      }
      return read.message.type
    })
    expect(answered.filter((type) => type === 'error')).toEqual([])
    expect(first.droppedBinaryFrames).toEqual([0])
    expect(second.droppedBinaryFrames).toEqual([])
    fakeClient().requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    const replied = posted.map((frame) => {
      const read = readBridgeHostMessage(frame.json)
      if (!read.ok) {
        throw new Error(`the page would refuse this frame: ${read.refusal}`)
      }
      return read.message
    })
    expect(replied.filter((frame) => frame.type === 'reply')).toEqual([
      { v: 1, type: 'reply', id: ID, payload: rpcSuccess('wire-1', 'ok') }
    ])
  })
})

describe('a session that handshook before this host existed', () => {
  // Seed rebuilt hosts from reducer-owned handshake state because client replacement leaves the same document mounted.
  it('serves a request from a page that never said `ready` to this host', async () => {
    const probe = newProbe()
    await act(async () => {
      createTracked(
        createElement(Harness, {
          session: readyState('session-one'),
          sessionEstablished: true,
          posted: [],
          probe,
          faults: [],
          readies: []
        })
      )
    })
    await act(async () => {
      probe.view?.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'request', id: ID, method: 'status.get' }) }
      })
    })
    expect(fakeClient().requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('refuses one on a session the caller says nothing about', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests).toEqual([])
  })
})
