import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { clientFrame, createFakeRpcClient, flushBridge } from './bridge-host-test-fakes'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY
} from './bridge/bridge-envelope'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge/bridge-haptics-notify'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'

describe('notifications, refusals and the fence', () => {
  it('forwards foreground with the arity the page used, and the viewport whole', () => {
    const bridge = harness({ routeGrants: [] })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground', reason: 'app-resume' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'terminalViewport', terminal: 't1', cols: 80, rows: 24 })
    )
    expect(bridge.client.foregroundCalls).toEqual([[], ['app-resume']])
    expect(bridge.client.viewports).toEqual([{ terminal: 't1', cols: 80, rows: 24 }])
  })

  it('hands a page fault to the session and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'route threw', isRpcDeliveryUnknown: false }
      })
    )
    expect(bridge.frames()[0]).toMatchObject({
      type: 'init',
      grants: { native: expect.arrayContaining(['fault']) }
    })
    expect(bridge.pageFaults).toEqual([
      { category: 'Error', message: 'route threw', isRpcDeliveryUnknown: false }
    ])
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.diagnostics).toEqual([])
  })

  it('refuses a notify from a page it has told nothing, grant or no grant', () => {
    const bridge = harness()
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'route threw', isRpcDeliveryUnknown: false }
      })
    )
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'terminalViewport', terminal: 't1', cols: 80, rows: 24 })
    )
    expect(bridge.client.viewports).toEqual([])
    expect(bridge.pageFaults).toEqual([])
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_FAULT_GRANT, why: 'before-ready' },
      { kind: 'notify-refused', name: 'foreground', why: 'before-ready' },
      { kind: 'notify-refused', name: 'terminalViewport', why: 'before-ready' }
    ])
  })

  it('drops a page fault that arrives after the document said goodbye', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'late', isRpcDeliveryUnknown: false }
      })
    )
    expect(bridge.pageFaults).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'frame-after-close' }])
  })

  it('reports a listener that throws on a page fault once, and keeps reading', () => {
    const failure = new Error('the session is gone')
    const bridge = harness({
      onPageFault: () => {
        throw failure
      }
    })
    const fault = clientFrame({
      type: 'notify',
      name: BRIDGE_FAULT_GRANT,
      error: { category: 'Error', message: 'route threw', isRpcDeliveryUnknown: false }
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // Never let a throw escape the native event handler delivering this frame.
    bridge.host.receive(fault)
    bridge.host.receive(fault)
    expect(bridge.diagnostics).toEqual([{ kind: 'notify-failed', error: failure }])
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last().type).toBe('init')
  })

  it('reports a refused frame and forwards nothing from it', () => {
    const bridge = harness()
    bridge.host.receive('{"v":1,"type":')
    bridge.host.receive(clientFrame({ type: 'request', id: 'short', method: 'x' }))
    expect(bridge.diagnostics).toEqual([
      { kind: 'refused', refusal: 'malformed-json' },
      { kind: 'refused', refusal: 'unrecognised-message' }
    ])
    expect(bridge.client.requests).toHaveLength(0)
  })

  it('reports a client that throws on a notify once per session, and keeps reading', () => {
    const client = createFakeRpcClient()
    const failure = new Error('no client')
    const bridge = harness({
      client: {
        ...client,
        notifyForeground: () => {
          throw failure
        },
        updateTerminalSubscriptionViewport: () => {
          throw failure
        }
      }
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // Never let a throw escape the native event handler delivering this frame.
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'terminalViewport', terminal: 't1', cols: 80, rows: 24 })
    )
    expect(bridge.diagnostics).toEqual([{ kind: 'notify-failed', error: failure }])
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last().type).toBe('init')
  })

  it('reports a post that throws instead of rejecting, and does not take the sender down', () => {
    const failure = new Error('the bridge module is gone')
    const client = createFakeRpcClient()
    const bridge = harness({
      client,
      post: () => {
        throw failure
      }
    })
    // State frames run inside client fan-out; a thrown post must not take down sibling listeners.
    expect(() => client.pushState('reconnecting')).not.toThrow()
    expect(bridge.diagnostics).toEqual([{ kind: 'post-failed', error: failure }])
  })

  it('reports a failing post once per session', async () => {
    const failure = new Error('nowhere to post')
    const bridge = harness({ post: () => Promise.reject(failure) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    await flushBridge()
    expect(bridge.diagnostics).toEqual([{ kind: 'post-failed', error: failure }])
    expect(bridge.posted).toHaveLength(2)
  })

  it('forwards to the client it was built with, whatever the frame names', () => {
    const mine = createFakeRpcClient()
    const theirs = createFakeRpcClient()
    const bridge = harness({ ready: true, client: mine })
    harness({ client: theirs })
    bridge.host.receive(
      clientFrame({ type: 'request', id: ID, method: 'status.get', hostId: 'other-host' })
    )
    expect(mine.requests.map((request) => request.method)).toEqual(['status.get'])
    expect(theirs.requests).toHaveLength(0)
  })

  it('carries no host name into the client message it parsed', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(
      clientFrame({ type: 'request', id: ID, method: 'status.get', hostId: 'other-host' })
    )
    expect(bridge.client.requests[0]?.args).toEqual(['status.get'])
  })
})

// Back notify has no reply; diagnostics alone distinguish a successful pop from an empty native stack.
describe('navigate-back', () => {
  const back = clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY })

  it('pops the shell stack and asks the client for nothing', () => {
    const bridge = harness({ routeGrants: ['navigate'] })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: { native: ['fault', 'rpcEnvelope', 'navigate'] }
    })
    bridge.host.receive(back)
    expect(bridge.backPops).toEqual(['popped'])
    expect(bridge.navigations).toEqual([])
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.diagnostics).toEqual([])
  })

  it('reports the pop that found nothing, because the page hears nothing either way', () => {
    const bridge = harness({ onNavigateBack: () => 'nothing-to-pop' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(back)
    expect(bridge.backPops).toEqual(['nothing-to-pop'])
    expect(bridge.diagnostics).toEqual([{ kind: 'navigate-back-refused', why: 'nothing-to-pop' }])
  })

  it('names a pop refused for a pop already pending, which is a different bug', () => {
    const bridge = harness({ onNavigateBack: () => 'pop-pending' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(back)
    expect(bridge.diagnostics).toEqual([{ kind: 'navigate-back-refused', why: 'pop-pending' }])
  })

  it('refuses it from a page that has not asked for a session', () => {
    const bridge = harness()
    bridge.host.receive(back)
    expect(bridge.backPops).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_NAVIGATE_BACK_NOTIFY, why: 'before-ready' }
    ])
  })

  it('reports a screen that threw on the pop once, and keeps reading', () => {
    const failure = new Error('the stack is gone')
    const bridge = harness({
      onNavigateBack: () => {
        throw failure
      }
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // Never let a throw escape the native event handler delivering this frame.
    bridge.host.receive(back)
    bridge.host.receive(back)
    expect(bridge.diagnostics).toEqual([{ kind: 'notify-failed', error: failure }])
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last().type).toBe('init')
  })
})

// Validate external-link schemes at the envelope too; a page bypassing its own guard must not reach the device handler with arbitrary URLs.
describe('externalLink', () => {
  const open = (url: string) =>
    clientFrame({ type: 'notify', name: BRIDGE_EXTERNAL_LINK_GRANT, url })

  it('hands an allowed URL to the caller and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: { native: expect.arrayContaining(['externalLink']) }
    })
    bridge.host.receive(open('https://github.com/stablyai/orca/pull/1'))
    bridge.host.receive(open('mailto:someone@example.com'))
    expect(bridge.externalLinks).toEqual([
      'https://github.com/stablyai/orca/pull/1',
      'mailto:someone@example.com'
    ])
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.navigations).toEqual([])
    expect(bridge.diagnostics).toEqual([])
  })

  it('hands over the URL the parser read, not the string the page sent', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // The WHATWG parser strips tab/LF/CR and trims leading C0/space; these raw spellings pass a naive scheme check.
    bridge.host.receive(open('ht\ntps://example.com'))
    bridge.host.receive(open('https://example.com/a\r\n'))
    bridge.host.receive(open('  https://example.com/a  '))
    bridge.host.receive(open('https:example.com'))
    expect(bridge.externalLinks).toEqual([
      'https://example.com/',
      'https://example.com/a',
      'https://example.com/a',
      'https://example.com/'
    ])
  })

  it('refuses a scheme the grant does not cover, as a frame the reader never accepts', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'orca-mobile-web://s/x']) {
      bridge.host.receive(open(url))
    }
    expect(bridge.externalLinks).toEqual([])
    // Envelope refusal must precede grants/device dispatch; the reporter, not this host harness, deduplicates repeated diagnostics.
    expect(bridge.diagnostics).toEqual(
      Array.from({ length: 3 }, () => ({ kind: 'refused', refusal: 'unrecognised-message' }))
    )
  })

  it('refuses it from a page that has not asked for a session', () => {
    const bridge = harness()
    bridge.host.receive(open('https://example.com'))
    expect(bridge.externalLinks).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_EXTERNAL_LINK_GRANT, why: 'before-ready' }
    ])
  })
})

// Haptics use notify so row taps do not consume the 64-slot request window; observe device calls and refusal diagnostics.
describe('haptics', () => {
  const play = (kind: string) => clientFrame({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind })

  it('plays each kind on the device and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.grants.native).toContain('haptics')
    expect(init.type === 'init' && init.grants.native).not.toContain('native.haptics.trigger')
    for (const kind of ['mediumImpact', 'selection', 'success', 'error', 'edgeBump']) {
      bridge.host.receive(play(kind))
    }
    expect(bridge.haptics).toEqual(['mediumImpact', 'selection', 'success', 'error', 'edgeBump'])
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.diagnostics).toEqual([])
  })

  it('plays one per frame, so a twelve-row scroll is twelve taps and not one', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (let row = 0; row < 12; row += 1) {
      bridge.host.receive(play('selection'))
    }
    expect(bridge.haptics).toHaveLength(12)
  })

  it('plays nothing for a route that was granted no haptics', () => {
    const bridge = harness({
      routeGrants: MOBILE_WEB_SHELL_GRANTS.filter((grant) => grant !== BRIDGE_HAPTICS_GRANT)
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(play('selection'))
    expect(bridge.haptics).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_HAPTICS_NOTIFY, why: 'ungranted' }
    ])
  })

  it('plays nothing for a page that has not asked for a session', () => {
    const bridge = harness()
    bridge.host.receive(play('selection'))
    expect(bridge.haptics).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_HAPTICS_NOTIFY, why: 'before-ready' }
    ])
  })

  it('plays nothing for a kind this app has no function for', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(play('heavyImpact'))
    expect(bridge.haptics).toEqual([])
    // Unknown haptic kinds fail envelope parsing; older shells must not substitute a different effect.
    expect(bridge.diagnostics).toEqual([{ kind: 'refused', refusal: 'unrecognised-message' }])
  })
})

describe('the page erasing a one-shot route param', () => {
  // Forward both one-shot key and value to the native route holder; only it can compare before clearing (ruling 34).
  it('carries a page clear up with the param and the value it named', () => {
    const bridge = harness({ route: { pathname: '/h/host-a/session/wt-1' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_ROUTE_PARAM_CLEAR,
        param: 'paneKey',
        value: 'p-1'
      })
    )
    expect(bridge.routeParamClears()).toEqual([{ param: 'paneKey', value: 'p-1' }])
  })

  it('carries no clear up from a page that has not asked for a session', () => {
    const bridge = harness({ route: { pathname: '/h/host-a/session/wt-1' } })
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_ROUTE_PARAM_CLEAR,
        param: 'paneKey',
        value: 'p-1'
      })
    )
    expect(bridge.routeParamClears()).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_ROUTE_PARAM_CLEAR, why: 'before-ready' }
    ])
  })

  it('refuses a clear for a param the page may not erase', () => {
    const bridge = harness({ route: { pathname: '/h/host-a/session/wt-1' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: BRIDGE_ROUTE_PARAM_CLEAR, param: 'name', value: 'x' })
    )
    expect(bridge.routeParamClears()).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'refused', refusal: 'unrecognised-message' }])
  })
})

// Only first-frame proves a rendered tree; WebView commit and pre-render ready cannot justify uncovering the page.
describe('the page reporting its first frame', () => {
  it('hands the report to the session and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }))
    expect(bridge.pagePaintCount()).toBe(1)
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toHaveLength(0)
  })

  it('refuses a report from a document nothing has answered', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }))
    expect(bridge.pagePaintCount()).toBe(0)
    expect(bridge.diagnostics).toContainEqual({
      kind: 'notify-refused',
      name: BRIDGE_PAGE_PAINTED,
      why: 'before-ready'
    })
  })
})
