import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { HostStackNavigationState } from './host-stack-navigation'

const HOST_ROUTE: HostStackNavigationState = {
  index: 0,
  routes: [{ name: 'h' }]
}
// The same host route as the root container sees it, with the host list's stack already mounted.
const MOUNTED_HOST_ROUTE: HostStackNavigationState = {
  index: 0,
  routes: [
    {
      name: 'h',
      state: {
        key: '/h',
        index: 0,
        routes: [{ key: 'host-index', name: '[hostId]/index', params: { hostId: 'host-1' } }]
      }
    }
  ]
}

const nav = vi.hoisted(() => ({ push: vi.fn(), dispatch: vi.fn() }))
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  // A screen's navigator keeps its last snapshot of a child stack until that stack next changes.
  useNavigation: () => ({
    addListener: () => () => {},
    dispatch: nav.dispatch,
    getState: () => HOST_ROUTE
  }),
  useNavigationContainerRef: () => ({ isReady: () => true, getRootState: () => MOUNTED_HOST_ROUTE })
}))

import { useOpenHostStackRoute } from './use-open-host-stack-route'

it('hands a session to the host list that just mounted instead of pushing a second document', async () => {
  const opener: { open?: ReturnType<typeof useOpenHostStackRoute> } = {}
  function Opener() {
    opener.open = useOpenHostStackRoute(true)
    return null
  }
  await act(async () => {
    create(createElement(Opener))
  })

  opener.open?.('host-1', {
    name: '[hostId]/session/[worktreeId]',
    params: { hostId: 'host-1', worktreeId: 'wt-1' }
  })

  expect(nav.push).not.toHaveBeenCalled()
  expect(nav.dispatch.mock.calls).toEqual([
    [
      {
        type: 'SET_PARAMS',
        target: '/h',
        source: 'host-index',
        payload: { params: { open: '%2Fh%2Fhost-1%2Fsession%2Fwt-1' } }
      }
    ]
  ])
})
