import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { clientFrame, createFakeRpcClient, flushBridge } from './bridge-host-test-fakes'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY
} from './bridge/bridge-envelope'
import { BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT } from './bridge/bridge-page-client-identity'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import {
  BRIDGE_HAPTICS_GRANT,
  BRIDGE_HAPTICS_KINDS,
  BRIDGE_HAPTICS_NOTIFY
} from './bridge/bridge-haptics-notify'
import { BRIDGE_NATIVE_GRANTS } from './bridge/bridge-init-frame'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'

describe('notifications, refusals and the fence', () => {
  it('forwards foreground with the arity the page used, and the viewport whole', () => {
    const bridge = harness()
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
    expect(bridge.pageFaults).toEqual([])
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.diagnostics).toEqual([
      { kind: 'notify-refused', name: BRIDGE_FAULT_GRANT, why: 'before-ready' },
      { kind: 'notify-refused', name: 'foreground', why: 'before-ready' }
    ])
  })

  it('serves the grant it issued once the page has asked for a session', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    // The list on the wire is the list the check above reads; a host that offered one and enforced
    // another would pass every other test in this file.
    expect(init.type === 'init' && init.grants.native).toEqual(BRIDGE_NATIVE_GRANTS)
    bridge.host.receive(
      clientFrame({
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'route threw', isRpcDeliveryUnknown: false }
      })
    )
    expect(bridge.pageFaults).toHaveLength(1)
    expect(bridge.diagnostics).toEqual([])
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
    // The page's frame arrives on a native event handler, and a throw that escapes this arm takes
    // that handler down with it.
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
    // The page's frame arrives on a native event handler, and a throw that escapes this arm takes
    // that handler down with it.
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
    // The `state` frame is sent from inside the client's own fan-out, so a throw here would reach
    // every other listener that client has.
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

/**
 * The one notify whose sink is the shell's own stack rather than the client or the app store.
 *
 * Nothing crosses back, so the only thing that can tell a pop from a page tapping into a stack that
 * has nothing left is the diagnostic: a dead Back button is exactly what silence here would hide.
 */
describe('navigate-back', () => {
  const back = clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY })

  it('pops the shell stack and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
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

  it('is carried by the navigate grant this host already issues, under no name of its own', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.grants.native).toContain('navigate')
    expect(init.type === 'init' && init.grants.native).not.toContain(BRIDGE_NAVIGATE_BACK_NOTIFY)
  })

  it('reports a screen that threw on the pop once, and keeps reading', () => {
    const failure = new Error('the stack is gone')
    const bridge = harness({
      onNavigateBack: () => {
        throw failure
      }
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // The frame arrives on a native event handler, and a throw that escapes takes it down.
    bridge.host.receive(back)
    bridge.host.receive(back)
    expect(bridge.diagnostics).toEqual([{ kind: 'notify-failed', error: failure }])
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last().type).toBe('init')
  })
})

/**
 * The one notify that leaves the app rather than the page.
 *
 * Nothing crosses back, so a refusal is only ever a log. Which is why the scheme is checked at the
 * frame and not only at the page's call site: a page that skipped its own check would otherwise
 * hand the device handler whatever it liked.
 */
describe('externalLink', () => {
  const open = (url: string) =>
    clientFrame({ type: 'notify', name: BRIDGE_EXTERNAL_LINK_GRANT, url })

  it('hands an allowed URL to the caller and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
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
    // Each of these passes the scheme check and is not what a device handler should be given: the
    // WHATWG parser strips tab, LF and CR anywhere and trims leading C0 and space.
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
    // Dropped by the envelope rather than by the grant check, which is what keeps a page that
    // skipped its own check from reaching the device handler at all. One per frame: the bound to
    // a line per cause is the reporter's, and this harness reads what the host actually said.
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

  it('is advertised under its own grant name, which a route can declare', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.grants.native).toContain(BRIDGE_EXTERNAL_LINK_GRANT)
  })
})

/**
 * The notify that reaches hardware.
 *
 * Nothing crosses back, which is the reason it is a notify: a reply would spend a slot in the same
 * 64-deep in-flight window a forwarded request does, and the file explorer plays one per row tap.
 * So the oracle is what the shell was asked to play, and the refusals are the only report there is.
 */
describe('haptics', () => {
  const play = (kind: string) => clientFrame({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind })

  it('plays each kind on the device and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (const kind of BRIDGE_HAPTICS_KINDS) {
      bridge.host.receive(play(kind))
    }
    expect(bridge.haptics).toEqual([...BRIDGE_HAPTICS_KINDS])
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
    // Granted everything else this shell implements, so the refusal is this row and not an empty list.
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
    // Dropped by the envelope rather than by the grant check: the kinds are a closed list, so a
    // shell older than a kind refuses the whole frame instead of playing something else.
    expect(bridge.diagnostics).toEqual([{ kind: 'refused', refusal: 'unrecognised-message' }])
  })

  it('is advertised under the token a route can declare, not under the notify name', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.grants.native).toContain(BRIDGE_HAPTICS_GRANT)
    expect(init.type === 'init' && init.grants.native).not.toContain(BRIDGE_HAPTICS_NOTIFY)
  })
})

describe('the page erasing a one-shot route param', () => {
  /**
   * The reader erasing its own request (ruling 34). One page-to-shell frame, carried up to
   * whoever holds the param; the comparison is theirs, so the host forwards both values as sent.
   */
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

  it('tells the page it takes a clear, so a page built for an older shell does not post one', () => {
    const bridge = harness({ route: { pathname: '/h/host-a/session/wt-1' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    // Written out rather than compared against `BRIDGE_SHELL_ACCEPTS`: a list that pins itself
    // pins nothing, and this is the frame an older page reads to decide what it may post.
    expect(init.type === 'init' && init.accepts).toEqual([
      BRIDGE_ROUTE_PARAM_CLEAR,
      BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT,
      BRIDGE_PAGE_PAINTED
    ])
  })
})

/**
 * The page's word about its own document, which is the only thing that says the view is worth
 * uncovering: a document commit is the WebView's, and `ready` is posted before a tree is built.
 */
describe('the page reporting its first frame', () => {
  it('hands the report to the session and asks the client for nothing', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready', reports: [BRIDGE_PAGE_PAINTED] }))
    bridge.host.receive(clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }))
    expect(bridge.pagePaintCount()).toBe(1)
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toHaveLength(0)
  })

  it('forwards what each ready declared, including a name this shell does not implement', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready', reports: [BRIDGE_PAGE_PAINTED, 'weather'] }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.pageReports()).toEqual([[BRIDGE_PAGE_PAINTED, 'weather'], []])
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
