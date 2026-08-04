import { describe, expect, it, vi } from 'vitest'
import {
  hostRouteEditRedirect,
  mobileHostEditRoute,
  navigateToMobileHostEdit
} from './host-edit-navigation'

describe('mobileHostEditRoute', () => {
  it('keeps the dynamic host segment explicit for a cold host navigator', () => {
    expect(mobileHostEditRoute('host-1')).toEqual({
      pathname: '/h/[hostId]/edit',
      params: { hostId: 'host-1' }
    })
  })
})

describe('navigateToMobileHostEdit', () => {
  it('lands on the host index with an explicit edit action instead of a frame-timed replace', () => {
    const push = vi.fn()
    const replace = vi.fn()

    navigateToMobileHostEdit({ push, replace }, 'host-1')

    expect(push).toHaveBeenCalledWith('/h/host-1?action=edit')
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('hostRouteEditRedirect', () => {
  it('redirects the mounted index route to the edit screen', () => {
    expect(hostRouteEditRedirect('edit', 'host-1')).toEqual(mobileHostEditRoute('host-1'))
  })

  it.each([
    ['a different action', 'newWorktree', 'host-1'],
    ['no action', undefined, 'host-1'],
    ['a missing host id', 'edit', undefined]
  ])('stays put for %s', (_label, action, hostId) => {
    expect(hostRouteEditRedirect(action, hostId)).toBeNull()
  })
})
