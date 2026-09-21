import {
  createElement,
  useImperativeHandle,
  useLayoutEffect,
  useState,
  type ReactElement
} from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge/bridge-native-verbs'
import {
  BRIDGE_HAPTICS_GRANT,
  BRIDGE_HAPTICS_NOTIFY,
  type BridgeHapticsKind
} from './bridge/bridge-haptics-notify'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'
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

// Reaching the real one imports the Expo runtime this test does not have; the hook reads one field.
vi.mock('../transport/client-context', () => ({
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

const ID = bridgeId(1)
const DIRECTORY = '/caches/mobile-web/deadbeef/generations/a1b2'

/** Each post is stamped with the mount that carried it, which is the only way to see a retiring
 *  host's teardown land in the page that replaced it. */
type PostedFrame = { sessionId: string; json: string }

type Probe = {
  view: MobileWebShellBridgeView | null
  navigations: string[]
  externalLinks: string[]
  haptics: BridgeHapticsKind[]
  backPops: number
  storageWrites: { key: string; value: string | null }[]
  /** The running total after each dropped screencast frame, as the screen receives it. */
  droppedBinaryFrames: number[]
}

/** What the page cannot read for itself, as the screen hands it over. */
const SNAPSHOT = {
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 7 }
}

/** Read on every `init` rather than captured once, so this is a function here as it is there. */
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

/**
 * Delivers a frame from a layout effect of the hook's *parent*, which React runs after the hook's
 * own commit work and before any passive effect. That is where a native message lands while React
 * still has passive work queued, and it is the only window this suite can address.
 */
function DeliverDuringCommit(props: {
  /** Delivered in order from the parent's layout effect, so a session can be opened and used in
   *  one commit — which is what a native batch carrying both frames looks like. */
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
  /** What the screen's own reducer says about this session; false for every case but the fence's. */
  sessionEstablished?: boolean
  posted: PostedFrame[]
  probe: Probe
  faults: BridgeErrorCapture[]
  readies: string[]
}): ReactElement | null {
  // The screen's own reducer in miniature: the handshake is a fact about the session, so the
  // render that carries it is what a host rebuilt over that session is built from.
  const [handshook, setHandshook] = useState<string | null>(null)
  const sessionId = props.session.kind === 'ready' ? props.session.sessionId : null
  const view = useMobileWebShellBridge({
    hostId: 'host-1',
    session: props.session,
    sessionEstablished: props.sessionEstablished ?? (sessionId !== null && handshook === sessionId),
    // Built inline on every render, as a caller writes it: the host is not rebuilt for it.
    route: { pathname: '/h/host-1' },
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
    // A fresh closure every render, which is the shape a screen passes and the one a ref must
    // absorb: rebuilding the host here would settle every pending request on each render.
    onPageFault: (error) => props.faults.push(error),
    onRouteRefused: () => {},
    onRouteParamClear: () => {},
    onBinaryFramesDropped: (total) => props.probe.droppedBinaryFrames.push(total),
    onPageReady: () => {
      setHandshook(sessionId)
      props.readies.push(sessionId ?? props.session.kind)
    }
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
  /** The session id of every `ready` the page asked for, in order. */
  readies: string[]
  update: (session: MobileWebShellSessionState) => Promise<void>
  deliver: (json: string) => Promise<void>
  frames: (sessionId: string) => BridgeHostMessage[]
}

let warned: MockInstance<typeof console.warn>

async function mount(session: MobileWebShellSessionState): Promise<Mounted> {
  const posted: PostedFrame[] = []
  const probe: Probe = {
    view: null,
    navigations: [],
    externalLinks: [],
    haptics: [],
    backPops: 0,
    droppedBinaryFrames: [],
    storageWrites: []
  }
  const faults: BridgeErrorCapture[] = []
  const readies: string[] = []
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  const render = (next: MobileWebShellSessionState): ReactElement =>
    createElement(Harness, { session: next, posted, probe, faults, readies })
  await act(async () => {
    rendered.tree = create(render(session))
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
    // Read back through the page's own reader: a frame the page would refuse never arrives.
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
  // `spyOn` on an already-spied method hands back the same mock, calls and all.
  warned.mockClear()
})

describe('the bridge channel', () => {
  it('is closed until the session is ready and opens with it', async () => {
    const mounted = await mount({ kind: 'checking' })
    expect(mounted.probe.view?.bridgeEnabled).toBe(false)
    await mounted.update(readyState('session-one'))
    expect(mounted.probe.view?.bridgeEnabled).toBe(true)
  })

  it('answers the page through the handle of the session it belongs to', async () => {
    const mounted = await mount(readyState('session-one'))
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
    // Same session, re-rendered: the harness passes a fresh `{ pathname }` every time. A rebuilt
    // host would have settled that request delivery-unknown on its way out.
    await mounted.update(readyState('session-one'))
    expect(mounted.frames('session-one').filter((frame) => frame.type === 'error')).toEqual([])
  })

  it('hands a page fault to the screen and asks the client for nothing', async () => {
    const mounted = await mount(readyState('session-one'))
    // The grant comes with the session, so the page asks for one before it reports anything.
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
    // The live page asks first, so the host that hears the stale frame has issued its grants: what
    // refuses the frame below is the session fence and not a page that had been told nothing.
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
})

describe('teardown', () => {
  it('posts a retiring session nothing into the page that replaced it', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await mounted.update(readyState('session-two'))
    expect(mounted.frames('session-two')).toEqual([])
    // The retiring host still tried, and the rejection is what said the view was gone.
    expect(warned).toHaveBeenCalledTimes(1)
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
    // The `init` the session opened with, and nothing after the host left ready.
    expect(mounted.frames('session-one').filter((frame) => frame.type !== 'init')).toEqual([])
    expect(fakeClient().requests).toEqual([])
  })

  /** The one thing a dropped frame leaves behind on a device, so the hook carrying it to the
   *  screen is the whole of that evidence path. */
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
    // The leading 0 is the host announcing a fresh count as it is built; then one per drop.
    expect(mounted.probe.droppedBinaryFrames).toEqual([0, 1, 2])
    // Dropped, not ended: the stream is still the shell's to serve.
    expect(fakeClient().streams[0]?.unsubscribes).toBe(0)
  })

  /**
   * The count belongs to the host, so it has to go when the host does.
   *
   * Without this the screen keeps the retired host's number and the next drop reports the new
   * host's first, so the line reads lower than it did a moment ago — which is worse than starting
   * over, because a number that falls looks like frames coming back.
   */
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
    // Zero again on the rebuild, before the new host has dropped anything of its own.
    expect(mounted.probe.droppedBinaryFrames).toEqual([0, 1, 0])
  })

  it('disposes on unmount and settles what was in flight as delivery-unknown', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await act(async () => {
      mounted.tree.unmount()
    })
    // The commit tears the host down while its own view is still attached, so the page hears why
    // its request will never answer instead of being left holding it.
    expect(mounted.frames('session-one').filter((frame) => frame.type !== 'init')).toEqual([
      expect.objectContaining({ type: 'error', id: ID })
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
    // No `ready` first, so the page holds nothing the host issued and the frame is refused for it.
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

describe('the callbacks a render passes', () => {
  it('faults into the latest render, not into the closure the host was built with', async () => {
    const first: BridgeErrorCapture[] = []
    const second: BridgeErrorCapture[] = []
    const posted: PostedFrame[] = []
    const probe: Probe = {
      view: null,
      navigations: [],
      externalLinks: [],
      haptics: [],
      backPops: 0,
      droppedBinaryFrames: [],
      storageWrites: []
    }
    // One session throughout, so the host is never rebuilt: only the ref refresh can carry the
    // second render's callback to a frame that arrives after it.
    const render = (faults: BridgeErrorCapture[]): ReactElement =>
      createElement(Harness, {
        session: readyState('session-one'),
        posted,
        probe,
        faults,
        readies: []
      })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(render(first))
    })
    await act(async () => {
      rendered.tree?.update(render(second))
    })
    const deliver = async (json: string): Promise<void> => {
      await act(async () => {
        probe.view?.onBridgeMessage({ nativeEvent: { json } })
      })
    }
    await deliver(clientFrame({ type: 'ready' }))
    await deliver(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
      })
    )
    expect(first).toEqual([])
    expect(second).toEqual([
      { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    ])
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
      storageWrites: []
    }
    const render = (deliver: readonly string[]): ReactElement =>
      createElement(DeliverDuringCommit, { deliver, posted, probe, faults: [], readies: [] })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(render([]))
    })
    const next = createFakeRpcClient()
    doubles.client = next
    // The session id does not change, so the handler's own fence does not apply: only handing the
    // host over in the commit keeps this frame off the client that was replaced. The `ready` rides
    // with it because the rebuilt host has issued no `init` and serves no request before one.
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
    storageWrites: []
  }
}

describe('the props one render passed', () => {
  /**
   * The host is built once per session and must call what the render on screen handed over, so a
   * mount that replaced every closure has to be the one every frame reaches.
   *
   * Host identity is asserted two ways, because it is not returned: a rebuild would settle the
   * request opened below as an `error` frame on its way out, and would announce a fresh
   * dropped-frame count to whichever render was current when it was built.
   */
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
      rendered.tree = create(render(first, firstFaults, firstReadies))
    })
    const deliver = async (probe: Probe, json: string): Promise<void> => {
      await act(async () => {
        probe.view?.onBridgeMessage({ nativeEvent: { json } })
      })
    }
    await deliver(first, clientFrame({ type: 'ready' }))
    // Left open across the re-render: a rebuilt host settles it delivery-unknown on its way out.
    await deliver(first, clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await act(async () => {
      rendered.tree?.update(render(second, secondFaults, secondReadies))
    })
    for (const json of [
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-1/session/wt-2' }),
      clientFrame({ type: 'notify', name: 'externalLink', url: 'https://example.com/y' }),
      clientFrame({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind: 'selection' }),
      clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }),
      // Answered out of `readStorage`, so this frame pins that callback as well as the write.
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
      // The handshake the first render was on screen for, and nothing after it.
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
    // Announced once, to the render that was on screen when the one host was built.
    expect(first.droppedBinaryFrames).toEqual([0])
    expect(second.droppedBinaryFrames).toEqual([])
  })
})

describe('a session that handshook before this host existed', () => {
  /**
   * A host is rebuilt when the client under it changes, and the page is never told: the session id
   * is the same, so it neither handshakes again nor hears that the shell was replaced.
   *
   * Whether the session is open is a fact about the session, so the host takes it from the render
   * rather than from anything this mount remembered — which is what makes it survive a mount.
   */
  it('serves a request from a page that never said `ready` to this host', async () => {
    const probe = newProbe()
    await act(async () => {
      create(
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

  /** The control: the same frame on a session the caller has not opened is still refused, so the
   *  case above is the fence moving rather than the fence going. */
  it('refuses one on a session the caller says nothing about', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests).toEqual([])
  })
})
