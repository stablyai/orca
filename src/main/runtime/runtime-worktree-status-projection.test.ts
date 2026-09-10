import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary, RuntimeWorktreeStatus } from '../../shared/runtime-types'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'

/** The rollup reads only these two fields, so a focused summary keeps the case readable. */
function summary(
  status: RuntimeWorktreeStatus,
  workingMode?: RuntimeWorktreePsSummary['workingMode']
): RuntimeWorktreePsSummary {
  return { status, ...(workingMode ? { workingMode } : {}) } as RuntimeWorktreePsSummary
}

describe('mergeWorktreeSummaryStatus', () => {
  it('promotes a worktree to the highest-ranked signal it holds', () => {
    // Pins the `worktree ps` ordering against a reordered shared ladder: the user-actionable
    // signal must outrank live work, and live work must outrank a terminal or idle one.
    const cases: readonly [RuntimeWorktreeStatus, RuntimeWorktreeStatus, RuntimeWorktreeStatus][] =
      [
        ['working', 'permission', 'permission'],
        ['done', 'working', 'working'],
        ['active', 'done', 'done'],
        ['inactive', 'active', 'active'],
        ['inactive', 'permission', 'permission']
      ]
    for (const [current, next, expected] of cases) {
      const s = summary(current)
      mergeWorktreeSummaryStatus(s, next)
      expect(s.status, `${current} + ${next}`).toBe(expected)
    }
  })

  it('never demotes a worktree to a lower-ranked signal', () => {
    const cases: readonly [RuntimeWorktreeStatus, RuntimeWorktreeStatus][] = [
      ['permission', 'working'],
      ['working', 'done'],
      ['done', 'active'],
      ['active', 'inactive']
    ]
    for (const [current, next] of cases) {
      const s = summary(current)
      mergeWorktreeSummaryStatus(s, next)
      expect(s.status, `${current} + ${next}`).toBe(current)
    }
  })

  it('carries workingMode only while the winning signal is monitoring work', () => {
    const promoted = summary('active')
    mergeWorktreeSummaryStatus(promoted, 'working', 'monitoring')
    expect(promoted.workingMode).toBe('monitoring')

    const foreground = summary('active')
    mergeWorktreeSummaryStatus(foreground, 'working')
    expect(foreground.workingMode).toBeUndefined()

    // A promotion past working drops the discriminator with it.
    const escalated = summary('working', 'monitoring')
    mergeWorktreeSummaryStatus(escalated, 'permission')
    expect(escalated.workingMode).toBeUndefined()
  })

  it('lets a foreground working signal clear monitoring at equal rank', () => {
    // Why: two panes in one worktree both report working; one is foreground, so the worktree
    // is not merely monitoring even though the rank does not move.
    const s = summary('working', 'monitoring')
    mergeWorktreeSummaryStatus(s, 'working')
    expect(s.status).toBe('working')
    expect(s.workingMode).toBeUndefined()

    const stays = summary('working', 'monitoring')
    mergeWorktreeSummaryStatus(stays, 'working', 'monitoring')
    expect(stays.workingMode).toBe('monitoring')
  })
})
