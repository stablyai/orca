import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from './mobile-session-route-types'

type RouteUpdateListener = (route: BridgeInitRoute | null) => void

const bridge = vi.hoisted(() => {
  const held: {
    route: BridgeInitRoute | null
    listeners: RouteUpdateListener[]
    /** Every erase the page asked the shell for, in order (ruling 34). */
    cleared: { param: string; value: string }[]
  } = { route: null, listeners: [], cleared: [] }
  return held
})

vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClient: () => ({
    getShellSession: () => ({ route: bridge.route }),
    onRouteUpdate: (listener: RouteUpdateListener) => {
      bridge.listeners.push(listener)
      return () => {
        bridge.listeners = bridge.listeners.filter((held) => held !== listener)
      }
    },
    clearRouteParam: (param: string, value: string) => {
      bridge.cleared.push({ param, value })
      return true
    }
  })
}))

import { useNotificationPaneNavigation } from './use-notification-pane-navigation.web'

/** A real leaf id: `parsePaneKey` refuses anything that is not one, so a made-up key parses to
 *  nothing and every case below would read as "the pane closed". */
const LEAF = '11111111-1111-4111-8111-111111111111'

const TABS: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    parentTabId: 'tab-a',
    leafId: LEAF,
    title: 'first',
    terminal: 'pty-a',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'tab-b',
    leafId: LEAF,
    title: 'second',
    terminal: 'pty-b',
    isActive: false
  }
]

const switched: MobileSessionTab[] = []

function Probe({ terminalsLoaded }: { terminalsLoaded: boolean }): null {
  useNotificationPaneNavigation({
    sessionTabs: TABS,
    terminalsLoaded,
    switchSessionTab: (tab) => switched.push(tab)
  })
  return null
}

function render(terminalsLoaded: boolean): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Probe, { terminalsLoaded }))
  })
  if (rendered.tree === null) {
    throw new Error('the probe did not render')
  }
  return rendered.tree
}

/** What the shell does: re-send `init`, which the client publishes as a route that moved. */
function deliver(paneKey: string): void {
  act(() => {
    for (const listener of bridge.listeners.slice()) {
      listener({ pathname: '/h/host-1/session/wt-1', params: { paneKey } })
    }
  })
}

beforeEach(() => {
  bridge.route = null
  bridge.listeners = []
  bridge.cleared.length = 0
  switched.length = 0
})

/**
 * The page's pane hook, which has no route to read and no param to write back.
 *
 * Its native sibling reads `paneKey` off the app's route and clears it with `setParams`; inside
 * the page the document is served at `/` with one history entry, so the request arrives as a
 * re-sent `init` instead (ruling 33.1) and the shell clears the native param once this page has
 * been handed one. The native file's test mounts the native file, and the bridge test stops at
 * the client, so this is the only cover this half has.
 */
describe('the page pane hook', () => {
  it('switches to the pane the page was opened on, which arrives in the first init', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('holds that request until the terminals have loaded, rather than dropping it', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    const tree = render(false)
    expect(switched).toEqual([])
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('erases the param that carried the pane it applied', () => {
    // The reader erases (ruling 34). The shell holds the request until the page that applied it
    // says so, naming the value: a tap that moved on since leaves a newer one on the route, and
    // the shell refuses this by comparison rather than by a sequence number.
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(bridge.cleared).toEqual([{ param: 'paneKey', value: `tab-b:${LEAF}` }])
  })

  it('switches again for a repeat tap on the pane already showing', () => {
    // The clear between the two is what makes the second a request rather than a repetition: the
    // shell erases the param, re-sends the route without it, and the tap writes it back.
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver('')
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'first'])
    expect(bridge.cleared).toEqual([
      { param: 'paneKey', value: `tab-a:${LEAF}` },
      { param: 'paneKey', value: `tab-a:${LEAF}` }
    ])
  })

  it('applies one pane once however many inits carry it', () => {
    // A re-asked `ready` is answered with the route the shell holds, which is still this one while
    // the clear is in flight or was lost. Applying is a no-op the second time; asking again is not,
    // because a clear that never arrived is repaired by this.
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toHaveLength(2)
  })

  it('takes the tap that arrived while it was applying the one before it', () => {
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-b:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'second'])
    // Both are named back; the shell spends only the one its param still holds.
    expect(bridge.cleared.map((entry) => entry.value)).toEqual([`tab-a:${LEAF}`, `tab-b:${LEAF}`])
  })

  it('takes a different pane as its own request', () => {
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-b:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'second'])
  })

  it('asks for nothing and applies nothing when the route carries no pane', () => {
    // Load-bearing rather than defensive: the shell's own erase comes back as a route that moved,
    // and so does every `ready` answered after it.
    render(true)
    deliver(`tab-a:${LEAF}`)
    bridge.cleared.length = 0
    deliver('')
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toEqual([])
  })

  it('consumes a request for a pane that has since closed, so no later render serves it', () => {
    render(true)
    deliver(`gone:${LEAF}`)
    expect(switched).toEqual([])
    // A re-render with nothing new delivered must not go looking for it again.
    deliver('')
    expect(switched).toEqual([])
  })

  it('does nothing at all when the page was opened on no pane', () => {
    render(true)
    expect(switched).toEqual([])
  })
})
