import { describe, expect, it, vi } from 'vitest'
import {
  coordinateHostStackNavigation,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from './host-stack-navigation'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'

function navigationHarness(initialState: HostStackNavigationState | undefined) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const unsubscribe = vi.fn()
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => {
        unsubscribe()
        stateListeners.delete(listener)
      }
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    unsubscribe,
    listenerCount: () => stateListeners.size,
    setState(nextState: HostStackNavigationState | undefined) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

function committedHostState(hostIdParam: string): HostStackNavigationState {
  return {
    index: 0,
    routes: [
      {
        name: 'h',
        state: {
          key: '/h',
          index: 0,
          routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: hostIdParam } }]
        }
      }
    ]
  }
}

describe('host stack navigation', () => {
  it('reuses the room on screen for its own tap and opens a different room over it', () => {
    const room = (groupId: string) => ({
      name: '[hostId]/group/[groupId]',
      params: { hostId: 'host/one', groupId }
    })
    const harness = navigationHarness({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 1,
            routes: [
              { key: 'host-index', name: '[hostId]/index', params: { hostId: 'host/one' } },
              { key: 'room-g', ...room('g') }
            ]
          }
        }
      ]
    })
    const router = { push: vi.fn(), replace: vi.fn() }

    navigateToHostStackRoute(harness.navigation, router, 'host/one', room('g'))
    navigateToHostStackRoute(harness.navigation, router, 'host/one', room('h'))

    expect(harness.navigation.dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      'SET_PARAMS',
      'PUSH'
    ])
  })

  it('pushes a group room from the host list even where sessions open inside its document', () => {
    const harness = navigationHarness(committedHostState('host/one'))
    const room = {
      name: '[hostId]/group/[groupId]',
      params: { hostId: 'host/one', groupId: 'g-1' }
    }

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      room,
      true
    )

    expect(harness.navigation.dispatch.mock.calls).toEqual([
      [{ type: 'PUSH', target: '/h', payload: room }]
    ])
  })

  describe('a session opened inside its host document', () => {
    const SESSION = {
      name: '[hostId]/session/[worktreeId]',
      params: { hostId: 'host/one', worktreeId: 'repo::/tmp/wt', paneKey: 'tab-1:leaf 2' }
    } as const
    it('opens a different session tapped while the push commits on the host stack it mounts', () => {
      const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
      const push = vi.fn()
      const router = { push, replace: vi.fn() }
      const OTHER_SESSION = {
        name: '[hostId]/session/[worktreeId]',
        params: { hostId: 'host/one', worktreeId: 'repo::/tmp/other' }
      } as const

      const pending = coordinateHostStackNavigation(
        null,
        harness.navigation,
        router,
        'host/one',
        SESSION,
        true
      )
      coordinateHostStackNavigation(
        pending,
        harness.navigation,
        router,
        'host/one',
        OTHER_SESSION,
        true
      )
      harness.setState(committedHostState('host/one'))

      expect(push).toHaveBeenCalledTimes(1)
      expect(harness.navigation.dispatch.mock.calls).toEqual([
        [
          {
            type: 'SET_PARAMS',
            target: '/h',
            source: 'host-index',
            payload: {
              params: { open: '%2Fh%2Fhost%252Fone%2Fsession%2Frepo%253A%253A%252Ftmp%252Fother' }
            }
          }
        ]
      ])
    })
  })
  it.each([
    ['ends an earlier item when it names none', {}, ''],
    [
      'carries its own item',
      { botItem: '{"sessionId":"lead","itemId":"q-2"}' },
      '{"sessionId":"lead","itemId":"q-2"}'
    ]
  ] as const)('a pane request reusing the session on screen %s', (_, item, botItem) => {
    const session = (params: Record<string, string>) => ({
      name: '[hostId]/session/[worktreeId]',
      params: { hostId: 'host/one', worktreeId: 'wt', ...params }
    })
    const harness = navigationHarness({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [
              {
                key: 'chat',
                ...session({ paneKey: 'pane-1', botItem: '{"sessionId":"lead","itemId":"q-1"}' })
              }
            ]
          }
        }
      ]
    })

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      session({ paneKey: 'pane-1', ...item })
    )

    expect(harness.navigation.dispatch.mock.calls[0][0].payload.params.botItem).toBe(botItem)
  })

  it('hands a pane request’s own intent to the session on screen and to its document', () => {
    const workspace = { hostId: 'host/one', worktreeId: 'wt' }
    const pane = { ...workspace, paneKey: 'pane-1' }
    const shown = mobileSessionRouteTarget(pane)
    const target = mobileSessionRouteTarget(pane)
    expect(target.params.paneIntent).toEqual(expect.any(String))
    expect(target.params.paneIntent).not.toBe(shown.params.paneIntent)
    expect(mobileSessionRouteTarget(workspace).params).not.toHaveProperty('paneIntent')
    const onScreen = navigationHarness({
      index: 0,
      routes: [
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [{ key: 'chat', ...shown }]
          }
        }
      ]
    })
    navigateToHostStackRoute(
      onScreen.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      target
    )
    expect(onScreen.navigation.dispatch.mock.calls[0][0].payload.params.paneIntent).toBe(
      target.params.paneIntent
    )

    const hostList = navigationHarness(committedHostState('host/one'))
    navigateToHostStackRoute(
      hostList.navigation,
      { push: vi.fn(), replace: vi.fn() },
      'host/one',
      target,
      true
    )
    const open = decodeURIComponent(
      hostList.navigation.dispatch.mock.calls[0][0].payload.params.open
    )
    expect(new URLSearchParams(open.split('?')[1]).get('paneIntent')).toBe(target.params.paneIntent)
  })
})
