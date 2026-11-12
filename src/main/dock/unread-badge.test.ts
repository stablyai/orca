import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { setBadge } = vi.hoisted(() => ({ setBadge: vi.fn() }))
vi.mock('electron', () => ({ app: { dock: { setBadge } } }))

import { setUnreadDockBadgeCount } from './unread-badge'

describe('setUnreadDockBadgeCount', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    setBadge.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefixes the unread count with ! while an agent needs input', () => {
    setUnreadDockBadgeCount(3, true)
    setUnreadDockBadgeCount(0, true)
    setUnreadDockBadgeCount(3)

    expect(setBadge.mock.calls).toEqual([['!3'], ['!'], ['3']])
  })
})
