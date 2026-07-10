import { describe, expect, it, vi } from 'vitest'

import { leaveHostRoute } from './host-route-exit'

function makeRouter() {
  return {
    replace: vi.fn()
  }
}

describe('leaveHostRoute', () => {
  it('returns to home instead of depending on route history', () => {
    const router = makeRouter()

    leaveHostRoute(router)

    expect(router.replace).toHaveBeenCalledWith('/')
  })
})
