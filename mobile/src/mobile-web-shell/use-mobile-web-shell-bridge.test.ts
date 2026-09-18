import { createElement, useImperativeHandle, useLayoutEffect, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { readBridgeHostMessage, type BridgeHostMessage } from './bridge/bridge-envelope'
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

type Probe = { view: MobileWebShellBridgeView | null }

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
  deliver: string | null
  posted: PostedFrame[]
  probe: Probe
}): ReactElement {
  const { deliver, probe } = props
  useLayoutEffect(() => {
    if (deliver !== null) {
      probe.view?.onBridgeMessage({ nativeEvent: { json: deliver } })
    }
  }, [deliver, probe])
  return createElement(Harness, {
    session: readyState('session-one'),
    posted: props.posted,
    probe
  })
}

function Harness(props: {
  session: MobileWebShellSessionState
  posted: PostedFrame[]
  probe: Probe
}): ReactElement | null {
  const view = useMobileWebShellBridge({ hostId: 'host-1', session: props.session })
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
  update: (session: MobileWebShellSessionState) => Promise<void>
  deliver: (json: string) => Promise<void>
  frames: (sessionId: string) => BridgeHostMessage[]
}

let warned: MockInstance<typeof console.warn>

async function mount(session: MobileWebShellSessionState): Promise<Mounted> {
  const posted: PostedFrame[] = []
  const probe: Probe = { view: null }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  const render = (next: MobileWebShellSessionState): ReactElement =>
    createElement(Harness, { session: next, posted, probe })
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

  it('forwards to the client the hook was given', async () => {
    const mounted = await mount(readyState('session-one'))
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
    await mounted.deliver(clientFrame({ type: 'subscribe', id: ID, method: 'x.sub', params: {} }))
    await mounted.update({ kind: 'failed', reason: 'render-process-gone', retriedOnce: false })
    expect(fakeClient().streams[0]?.unsubscribes).toBe(1)
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await mounted.deliver(clientFrame({ type: 'ready' }))
    expect(mounted.frames('session-one')).toEqual([])
    expect(fakeClient().requests).toEqual([])
  })

  it('disposes on unmount and settles what was in flight as delivery-unknown', async () => {
    const mounted = await mount(readyState('session-one'))
    await mounted.deliver(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await act(async () => {
      mounted.tree.unmount()
    })
    // The commit tears the host down while its own view is still attached, so the page hears why
    // its request will never answer instead of being left holding it.
    expect(mounted.frames('session-one')).toEqual([
      expect.objectContaining({ type: 'error', id: ID })
    ])
    expect(warned).not.toHaveBeenCalled()
    fakeClient().requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(mounted.posted).toHaveLength(1)
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
    const probe: Probe = { view: null }
    const render = (deliver: string | null): ReactElement =>
      createElement(DeliverDuringCommit, { deliver, posted, probe })
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(render(null))
    })
    const next = createFakeRpcClient()
    doubles.client = next
    // The session id does not change, so the handler's own fence does not apply: only handing the
    // host over in the commit keeps this frame off the client that was replaced.
    await act(async () => {
      rendered.tree?.update(render(clientFrame({ type: 'request', id: ID, method: 'status.get' })))
    })
    expect(first.requests).toHaveLength(0)
    expect(next.requests).toHaveLength(1)
  })
})
