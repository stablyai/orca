import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { listAutomationRunsPage } from './automation-run-operations'

function stateWithRuns(runs: { id: string; createdAt: number }[]): PersistedState {
  return {
    automationRuns: runs.map((run) => ({ ...run, automationId: 'a1' }))
  } as PersistedState
}

describe('listAutomationRunsPage', () => {
  it('returns a bounded, newest-first page and an opaque continuation cursor', () => {
    const state = stateWithRuns([
      { id: 'old', createdAt: 1 },
      { id: 'new', createdAt: 3 },
      { id: 'middle', createdAt: 2 }
    ])

    const first = listAutomationRunsPage(state, 'a1', 2)
    expect(first.runs.map((run) => run.id)).toEqual(['new', 'middle'])
    expect(first.nextCursor).not.toBeNull()

    expect(listAutomationRunsPage(state, 'a1', 2, first.nextCursor ?? undefined)).toEqual(
      expect.objectContaining({
        runs: [expect.objectContaining({ id: 'old' })],
        nextCursor: null
      })
    )
  })

  it('keeps the window stable when a newer run lands between pages', () => {
    const state = stateWithRuns([
      { id: 'r1', createdAt: 1 },
      { id: 'r2', createdAt: 2 },
      { id: 'r3', createdAt: 3 }
    ])

    const first = listAutomationRunsPage(state, 'a1', 2)
    expect(first.runs.map((run) => run.id)).toEqual(['r3', 'r2'])

    state.automationRuns = [
      ...state.automationRuns,
      { id: 'r4', automationId: 'a1', createdAt: 4 } as PersistedState['automationRuns'][number]
    ]

    const second = listAutomationRunsPage(state, 'a1', 2, first.nextCursor ?? undefined)
    expect(second.runs.map((run) => run.id)).toEqual(['r1'])
    expect(second.nextCursor).toBeNull()
  })

  it('resumes after a pruned boundary run instead of restarting the page', () => {
    const state = stateWithRuns([
      { id: 'r1', createdAt: 1 },
      { id: 'r2', createdAt: 2 },
      { id: 'r3', createdAt: 3 }
    ])
    const first = listAutomationRunsPage(state, 'a1', 2)

    state.automationRuns = state.automationRuns.filter((run) => run.id !== 'r2')

    expect(
      listAutomationRunsPage(state, 'a1', 2, first.nextCursor ?? undefined).runs.map(
        (run) => run.id
      )
    ).toEqual(['r1'])
  })

  it('keeps runs tied on createdAt when the boundary run is pruned', () => {
    const state = stateWithRuns([
      { id: 'r2', createdAt: 10 },
      { id: 'r1', createdAt: 10 },
      { id: 'r0', createdAt: 5 }
    ])
    const first = listAutomationRunsPage(state, 'a1', 1)
    expect(first.runs.map((run) => run.id)).toEqual(['r1'])

    state.automationRuns = state.automationRuns.filter((run) => run.id !== 'r1')

    expect(
      listAutomationRunsPage(state, 'a1', 2, first.nextCursor ?? undefined).runs.map(
        (run) => run.id
      )
    ).toEqual(['r2', 'r0'])
  })

  it('still honours a legacy offset cursor issued before the upgrade', () => {
    const state = stateWithRuns([
      { id: 'r1', createdAt: 1 },
      { id: 'r2', createdAt: 2 },
      { id: 'r3', createdAt: 3 }
    ])

    expect(listAutomationRunsPage(state, 'a1', 2, '2').runs.map((run) => run.id)).toEqual(['r1'])
  })
})
