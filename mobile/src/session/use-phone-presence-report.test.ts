import { createElement, Fragment, useContext, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { usePhonePresenceReport } from './use-phone-presence-report'

const lifecycle = vi.hoisted(() => ({
  appState: 'active',
  listeners: new Set<(state: string) => void>()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return lifecycle.appState
    },
    addEventListener(_event: string, listener: (state: string) => void) {
      lifecycle.listeners.add(listener)
      return { remove: () => lifecycle.listeners.delete(listener) }
    }
  }
}))

// A screen's focus comes from `RouteFocus`: the callback runs while it holds, its cleanup on blur.
const { RouteFocus } = await vi.hoisted(async () => {
  const { createContext } = await import('react')
  return { RouteFocus: createContext(true) }
})

vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const focused = useContext(RouteFocus)
    useEffect(() => (focused ? callback() : undefined), [callback, focused])
  }
}))

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const A = 'repo-1::/tmp/a'
const B = 'repo-1::/tmp/b'
const AWAY = { workspaceIds: [], tabIds: [], presentForMs: 0 }
const shows = (...workspaceIds: string[]) => ({ workspaceIds, tabIds: [], presentForMs: null })

type Screen = { worktreeId: string; focused: boolean }

/** A client whose transport holds the view as a session preamble, or an older one without it. */
function makeClient(holdsPreamble = true) {
  const setSessionPreamble = vi.fn((_key: string, _method: string, _params: unknown) => undefined)
  const sendRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only these.
  const client = (holdsPreamble
    ? { setSessionPreamble, sendRequest }
    : { sendRequest }) as unknown as RpcClient
  return {
    client,
    setSessionPreamble,
    sendRequest,
    views: () =>
      holdsPreamble
        ? setSessionPreamble.mock.calls.map(([, , params]) => params)
        : sendRequest.mock.calls.map(([, params]) => params)
  }
}

function harness(screens: Screen[], first = makeClient()) {
  function Probe(props: { worktreeId: string; client: RpcClient; state: ConnectionState }) {
    usePhonePresenceReport(props.client, props.state, props.worktreeId)
    return null
  }
  let state: ConnectionState = 'connected'
  const tree = (next: Screen[], client: RpcClient) =>
    createElement(
      Fragment,
      null,
      next.map((screen) =>
        createElement(
          RouteFocus.Provider,
          { key: screen.worktreeId, value: screen.focused },
          createElement(Probe, { worktreeId: screen.worktreeId, client, state })
        )
      )
    )
  let current = first
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(tree(screens, current.client))
  })
  return {
    reports: () => current.views(),
    last: () => current.views().at(-1),
    update: (next: Screen[], client = current, connState: ConnectionState = 'connected') => {
      current = client
      state = connState
      act(() => renderer.update(tree(next, client.client)))
    },
    unmount: () => act(() => renderer.unmount())
  }
}

function changeAppState(state: string): void {
  lifecycle.appState = state
  act(() => {
    for (const listener of lifecycle.listeners) {
      listener(state)
    }
  })
}

afterEach(() => {
  lifecycle.appState = 'active'
  lifecycle.listeners.clear()
})

describe('usePhonePresenceReport', () => {
  it('names the focused session route, and is away when another screen covers it', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
    // Settings pushed on top: the session stays mounted, but nobody sees it.
    h.update([{ worktreeId: A, focused: false }])
    expect(h.last()).toEqual(AWAY)
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
    h.unmount()
    expect(h.last()).toEqual(AWAY)
  })

  it('reports away in the background, and only the focused route on return', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    changeAppState('background')
    expect(h.last()).toEqual(AWAY)
    // iOS passes through inactive on the way back; only the edge into active is news.
    const sent = h.reports().length
    changeAppState('inactive')
    expect(h.reports()).toHaveLength(sent)
    // Foregrounded with settings still on top: still away.
    h.update([{ worktreeId: A, focused: false }])
    changeAppState('active')
    expect(h.last()).toEqual(AWAY)
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
  })

  it('names only the route on top when one session route is pushed over another', () => {
    const h = harness([{ worktreeId: A, focused: true }])
    h.update([
      { worktreeId: A, focused: false },
      { worktreeId: B, focused: true }
    ])
    expect(h.last()).toEqual(shows(B))
    h.update([{ worktreeId: A, focused: true }])
    expect(h.last()).toEqual(shows(A))
  })

  it('holds the view on a new client before a covered route re-subscribes on it', () => {
    const h = harness([{ worktreeId: A, focused: false }])
    const fresh = makeClient()
    h.update([{ worktreeId: A, focused: false }], fresh)
    expect(fresh.views()).toEqual([AWAY])
    expect(fresh.setSessionPreamble).toHaveBeenLastCalledWith(
      'sidebarInputs.reportView',
      'sidebarInputs.reportView',
      AWAY
    )
  })

  it('sends a plain request to a client without a preamble, and ignores a refusal', async () => {
    const older = makeClient(false)
    older.sendRequest.mockRejectedValue(new Error('method_not_found'))
    const h = harness([{ worktreeId: A, focused: true }], older)
    changeAppState('background')
    await Promise.resolve()
    expect(h.last()).toEqual(AWAY)
    expect(older.sendRequest).toHaveBeenCalledWith('sidebarInputs.reportView', AWAY)
  })

  // The web page's shell bridge client survives native reconnects and holds no preamble.
  it('says the view again on every connect to a client that holds no preamble', () => {
    const bridge = makeClient(false)
    const screens = [{ worktreeId: A, focused: true }]
    const h = harness(screens, bridge)
    expect(h.reports()).toEqual([AWAY, shows(A)])
    h.update(screens, bridge, 'reconnecting')
    const sent = h.reports().length
    h.update(screens, bridge, 'connected')
    expect(h.reports().slice(sent).at(-1)).toEqual(shows(A))
    // Backgrounded across the drop: the new connection hears away, not the stale view.
    h.update(screens, bridge, 'reconnecting')
    changeAppState('background')
    h.update(screens, bridge, 'connected')
    expect(h.last()).toEqual(AWAY)
  })

  it('leaves resending to a transport that holds the view as a preamble', () => {
    const screens = [{ worktreeId: A, focused: true }]
    const h = harness(screens)
    const sent = h.reports().length
    h.update(screens, undefined, 'reconnecting')
    h.update(screens, undefined, 'connected')
    expect(h.reports()).toHaveLength(sent)
  })
})
