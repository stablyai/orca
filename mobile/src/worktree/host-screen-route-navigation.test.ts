import { describe, expect, it, vi } from 'vitest'
import { navigateFromHostScreenList } from './host-screen-route-navigation'

describe('host screen route navigation', () => {
  it('pushes from the routed phone list', () => {
    const router = routeRouter()

    navigateFromHostScreenList({
      router,
      pathname: '/h/host-1',
      target: '/h/host-1/tasks',
      embedded: false,
      hostId: 'host-1'
    })

    expect(router.push).toHaveBeenCalledWith('/h/host-1/tasks')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('pushes the first detail and replaces later details in an embedded list', () => {
    const router = routeRouter()

    navigateFromHostScreenList({
      router,
      pathname: '/h/host-1',
      target: '/h/host-1/tasks',
      embedded: true,
      hostId: 'host-1'
    })
    navigateFromHostScreenList({
      router,
      pathname: '/h/host-1/tasks',
      target: '/h/host-1/accounts',
      embedded: true,
      hostId: 'host-1'
    })

    expect(router.push).toHaveBeenCalledWith('/h/host-1/tasks')
    expect(router.replace).toHaveBeenCalledWith('/h/host-1/accounts')
  })

  it('does not navigate an embedded list to its current detail', () => {
    const router = routeRouter()

    navigateFromHostScreenList({
      router,
      pathname: '/h/host-1/tasks',
      target: '/h/host-1/tasks?filter=open',
      embedded: true,
      hostId: 'host-1'
    })

    expect(router.push).not.toHaveBeenCalled()
    expect(router.replace).not.toHaveBeenCalled()
  })
})

function routeRouter() {
  return {
    push: vi.fn(),
    replace: vi.fn()
  }
}
