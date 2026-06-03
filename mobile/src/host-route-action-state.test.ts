import { describe, expect, it } from 'vitest'

import {
  createInitialHostRouteActionState,
  resolveHostRouteActionState,
  setHostRouteNewWorktreeVisible
} from './host-route-action-state'

describe('host route action state', () => {
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
