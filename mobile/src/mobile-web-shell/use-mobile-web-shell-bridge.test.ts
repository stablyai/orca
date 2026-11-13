import { createElement, useImperativeHandle, useState, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge/bridge-native-verbs'
import { BRIDGE_HAPTICS_GRANT, type BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge/bridge-page-back'
import {
  BRIDGE_FAULT_GRANT,
  readBridgeHostMessage,
  type BridgeHostMessage
} from './bridge/bridge-envelope'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { FakeRpcClient } from './bridge-host-test-fakes'
import type { PageHostSnapshot } from './use-page-host-snapshot'

const doubles = vi.hoisted((): { client: FakeRpcClient | null } => ({ client: null }))

// Stub Expo-dependent client lookup; the hook reads only identity.
vi.mock('../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ client: doubles.client })
}))

import { bridgeId, clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import {
  useMobileWebShellBridge,
  type MobileWebShellBridgeView
} from './use-mobile-web-shell-bridge'

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
      },
      createVisualDocument: async () => {
        throw new Error('This bridge fixture creates no visual')
      },
      releaseVisualDocument: async () => {}
    }),
    [props.posted, props.sessionId]
  )
  return null
}

// Deliver from the parent layout effect after hook commit work but before passive effects, matching the native-message race window.

function Harness(props: {
  session: MobileWebShellSessionState
  sessionEstablished?: boolean
  snapshot?: PageHostSnapshot | null
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
    // This connection's verdict is open, so desktop-bound frames pass.
    hostStatus: { protocolVersion: 1 },
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
    snapshot: props.snapshot === undefined ? SNAPSHOT : props.snapshot,
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
    elapsedMs: 11,
    compat: {
      schemaVersion: 1,
      runtimeProtocolVersion: 1,
      minCompatibleRuntimeProtocolVersion: 1,
      pageVersion: 1
    }
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
  sessionEstablished?: boolean,
  snapshot?: PageHostSnapshot | null
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
      ...(snapshot === undefined ? {} : { snapshot }),
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('the bridge channel', () => {
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
})

describe('client changes', () => {
  // Client replacement preserves the live document/session; retain its Back state so an open sheet cannot lose the next press.

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
})

describe('a session that handshook before this host existed', () => {
  // Seed rebuilt hosts from reducer-owned handshake state because client replacement leaves the same document mounted.

  it('refuses one on a session the caller says nothing about', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(fakeClient().requests).toEqual([])
  })
})

describe('a ready the page sent before its host existed', () => {
  it('is answered with one init as soon as the host snapshot arrives', async () => {
    const mounted = await mount(readyState('session-one'), undefined, null)
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.posted).toEqual([])
    await act(async () => {
      mounted.tree.update(
        createElement(Harness, {
          session: readyState('session-one'),
          snapshot: SNAPSHOT,
          posted: mounted.posted,
          probe: mounted.probe,
          faults: mounted.faults,
          readies: mounted.readies
        })
      )
    })
    expect(mounted.frames('session-one')).toEqual([
      expect.objectContaining({ type: 'init', sessionId: 'session-one', buildId: 'build-a' })
    ])
  })
})
