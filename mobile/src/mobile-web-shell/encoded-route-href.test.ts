import { describe, expect, it } from 'vitest'
import { encodedRouteHref } from './encoded-route-href'

describe('encodedRouteHref', () => {
  it('keeps a worktree id with slashes inside its own segment', () => {
    expect(
      encodedRouteHref(['h', '[hostId]', 'session', '[worktreeId]'], {
        hostId: 'host-1',
        worktreeId: 'repo::/private/tmp/wt/fold-layout'
      })
    ).toBe('/h/host-1/session/repo%3A%3A%2Fprivate%2Ftmp%2Fwt%2Ffold-layout')
  })

  it('drops groups and spreads catch-all values', () => {
    expect(
      encodedRouteHref(['(app)', 'h', '[hostId]', '[...page]'], {
        hostId: 'h 1',
        page: ['a', 'b/c']
      })
    ).toBe('/h/h%201/a/b%2Fc')
  })
})
