import { describe, expect, it } from 'vitest'

import {
  createInitialHostRouteActionState,
  hostNewWorktreeRoute,
  hostNewWorktreeSessionRoute,
  resolveHostRouteActionState,
  setHostRouteNewWorktreeVisible
} from './host-route-action-state'

describe('host route action state', () => {
  it('encodes opaque host ids in the new-worktree route segment', () => {
    expect(hostNewWorktreeRoute('relay/one#50%')).toBe('/h/relay%2Fone%2350%25?action=newWorktree')
  })

  it('preserves opaque host and worktree ids after creation', () => {
    expect(hostNewWorktreeSessionRoute('relay/one#50%', 'repo/one#20%', 'Relay workspace')).toBe(
      '/h/relay%2Fone%2350%25/session/repo%2Fone%2320%25?name=Relay+workspace&created=1'
    )
  })

  it('opens new worktree modal on an initial newWorktree action', () => {
    expect(createInitialHostRouteActionState('newWorktree')).toEqual({
      routeAction: 'newWorktree',
      showNewWorktree: true
    })
  })

  it('keeps initial non-action routes closed', () => {
    expect(createInitialHostRouteActionState(undefined)).toEqual({
      routeAction: undefined,
      showNewWorktree: false
    })
  })

  it('opens once when route action changes to newWorktree', () => {
    expect(
      resolveHostRouteActionState({ routeAction: undefined, showNewWorktree: false }, 'newWorktree')
    ).toEqual({
      routeAction: 'newWorktree',
      showNewWorktree: true
    })
  })

  it('does not reopen after user closes while route action is unchanged', () => {
    const closed = setHostRouteNewWorktreeVisible(
      { routeAction: 'newWorktree', showNewWorktree: true },
      false
    )

    expect(resolveHostRouteActionState(closed, 'newWorktree')).toBe(closed)
  })

  it('preserves an already-open modal when route action changes away', () => {
    expect(
      resolveHostRouteActionState({ routeAction: 'newWorktree', showNewWorktree: true }, undefined)
    ).toEqual({
      routeAction: undefined,
      showNewWorktree: true
    })
  })
})
