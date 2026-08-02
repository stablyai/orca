import { describe, expect, it, vi } from 'vitest'

import { leaveHostRoute } from './host-route-exit'

function makeRouter() {
  return {
    dismissTo: vi.fn()
  }
}

describe('leaveHostRoute', () => {
  // Why: dismissTo (not replace) is what makes the chevron animate back like swipe-back, so the
  // call shape is the behavior under test, not an implementation detail.
  it('dismisses to home instead of depending on route history', () => {
    const router = makeRouter()

    leaveHostRoute(router)

    expect(router.dismissTo).toHaveBeenCalledWith('/')
  })
})
