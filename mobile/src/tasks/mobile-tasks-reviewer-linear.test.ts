import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-tasks-dependencies', () => import('../theme/mobile-theme'))
import { reconcileTeamSelection } from './mobile-tasks-reviewer-linear'
import type { LinearTeam } from './mobile-tasks-provider-detail-types'

function team(id: string): LinearTeam {
  return { id, name: id, key: id.toUpperCase() }
}

describe('reconcileTeamSelection', () => {
  it('selects every team for sticky-all', () => {
    expect([...reconcileTeamSelection([team('a'), team('b')], null)]).toEqual(['a', 'b'])
  })

  it('keeps saved teams that still exist', () => {
    expect([...reconcileTeamSelection([team('a'), team('b')], ['b'])]).toEqual(['b'])
  })

  // Why: an older host projects its raw store value, which reached 1.4.207
  // desktops as a string (0a2b6e7f); the mobile list must not fail on it.
  it('reads a saved value of the wrong shape as sticky-all instead of throwing', () => {
    expect([...reconcileTeamSelection([team('a'), team('b')], 'a')]).toEqual(['a', 'b'])
    expect([...reconcileTeamSelection([team('a'), team('b')], { 0: 'a' })]).toEqual(['a', 'b'])
  })
})
