import { describe, expect, it, vi } from 'vitest'
import { mobileHostEditRoute, navigateToMobileHostEdit } from './host-edit-navigation'

describe('mobileHostEditRoute', () => {
  it('keeps the dynamic host segment explicit for a cold host navigator', () => {
    expect(mobileHostEditRoute('host-1')).toEqual({
      pathname: '/h/[hostId]/edit',
      params: { hostId: 'host-1' }
    })
  })

  it('mounts a cold host navigator before replacing its index with edit', () => {
    let nextFrame: FrameRequestCallback | null = null
    const push = vi.fn()
    const replace = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback
      return 1
    })

    navigateToMobileHostEdit({ push, replace }, 'host-1')
    expect(push).toHaveBeenCalledWith('/h/host-1')
    expect(replace).not.toHaveBeenCalled()

    nextFrame?.(0)
    expect(replace).toHaveBeenCalledWith(mobileHostEditRoute('host-1'))
    vi.unstubAllGlobals()
  })
})
