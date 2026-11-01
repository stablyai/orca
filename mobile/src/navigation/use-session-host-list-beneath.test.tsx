import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostStackNavigationState } from './host-stack-navigation'

const SESSION = '[hostId]/session/[worktreeId]'

const navigation = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const bag = {
    state: undefined as HostStackNavigationState | undefined,
    dispatch: vi.fn(),
    getState: () => bag.state,
    addListener: (_event: 'state', listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      for (const listener of listeners) {
        listener()
      }
    }
  }
  return bag
})

vi.mock('expo-router', () => ({
  useNavigation: () => navigation
}))

import { useSessionHostListBeneath } from './use-session-host-list-beneath'

function sessionOnlyState(): HostStackNavigationState {
  return {
    key: 'host-stack',
    index: 0,
    routes: [
      {
        key: 'session',
        name: SESSION,
        params: { hostId: 'host-1', worktreeId: 'wt' }
      }
    ]
  }
}

function Probe({ hostId }: { hostId: string | null }) {
  useSessionHostListBeneath(hostId)
  return null
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  navigation.state = undefined
  navigation.dispatch.mockClear()
})

describe('useSessionHostListBeneath', () => {
  it('resets the host stack once so the session list sits under the session', () => {
    const state = {
      ...sessionOnlyState(),
      type: 'stack',
      routeNames: ['[hostId]/index', SESSION]
    }
    navigation.state = state

    act(() => {
      renderer = create(createElement(Probe, { hostId: 'host-1' }))
    })

    expect(navigation.dispatch).toHaveBeenCalledTimes(1)
    expect(navigation.dispatch).toHaveBeenCalledWith({
      type: 'RESET',
      target: 'host-stack',
      payload: {
        ...state,
        index: 1,
        routes: [
          {
            key: 'host-session-list:host-1',
            name: '[hostId]/index',
            params: { hostId: 'host-1' }
          },
          state.routes[0]
        ]
      }
    })

    navigation.emit()
    expect(navigation.dispatch).toHaveBeenCalledTimes(1)
  })

  it('waits until the session is in the stack', () => {
    navigation.state = { index: 0, routes: [{ key: 'server', name: 'index' }] }
    act(() => {
      renderer = create(createElement(Probe, { hostId: 'host-1' }))
    })
    expect(navigation.dispatch).not.toHaveBeenCalled()

    navigation.state = sessionOnlyState()
    act(() => navigation.emit())
    expect(navigation.dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not reset when the host list is already under the session', () => {
    navigation.state = {
      key: 'host-stack',
      index: 1,
      routes: [
        { key: 'host-index', name: '[hostId]/index', params: { hostId: 'host-1' } },
        ...sessionOnlyState().routes
      ]
    }
    act(() => {
      renderer = create(createElement(Probe, { hostId: 'host-1' }))
    })
    act(() => navigation.emit())
    expect(navigation.dispatch).not.toHaveBeenCalled()
  })
})
