import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { BRIDGE_EXTERNAL_LINK_GRANT, BRIDGE_FAULT_GRANT } from './bridge/bridge-envelope'

import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge/bridge-haptics-notify'

import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'

describe('notifications, refusals and the fence', () => {
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
})

// Validate external-link schemes at the envelope too; a page bypassing its own guard must not reach the device handler with arbitrary URLs.
describe('externalLink', () => {
  const open = (url: string) =>
    clientFrame({ type: 'notify', name: BRIDGE_EXTERNAL_LINK_GRANT, url })

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
})

// Haptics use notify so row taps do not consume the 64-slot request window; observe device calls and refusal diagnostics.
describe('haptics', () => {
  const play = (kind: string) => clientFrame({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind })

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
})

describe('the page erasing a one-shot route param', () => {
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
