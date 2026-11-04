import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { automationRunFailure } from '../../../shared/automation-run-failure-copy'
import {
  snapshotAutomationRunWorkspaceDisplayName,
  type AutomationRunMutation,
  listAutomationRunsPage,
  recordRepeatedAutomationSkip,
  updateAutomationRun,
  type AutomationRunOperations
} from './automation-run-operations'

function stateWithRuns(runs: { id: string; createdAt: number }[]): PersistedState {
  return {
    automationRuns: runs.map((run) => ({ ...run, automationId: 'a1' }))
  } as PersistedState
}

describe('listAutomationRunsPage', () => {
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

describe('automation run failure codes', () => {
  it('persists the code beside the English error and drops it with the next result', () => {
    const state = stateWithRuns([{ id: 'r1', createdAt: 1 }])
    state.automationRuns[0] = {
      ...state.automationRuns[0],
      status: 'pending',
      trigger: 'scheduled',
      scheduledFor: 1
    }
    state.automations = []
    const operations: AutomationRunOperations = {
      state,
      flush: () => {},
      recordManualRun: () => {},
      getWorkspaceDisplayName: () => null
    }
    const failure = automationRunFailure('projectSetupNotReady', { setupState: 'setting-up' })
    updateAutomationRun(operations, {
      runId: 'r1',
      status: 'skipped_unavailable',
      ...failure
    })
    recordRepeatedAutomationSkip(operations, 'a1', failure.error, 2)
    // Usage writes forward only the English error.
    updateAutomationRun(operations, {
      runId: 'r1',
      status: 'skipped_unavailable',
      error: failure.error
    })

    const [stored] = JSON.parse(JSON.stringify(state.automationRuns))
    expect(stored).toMatchObject({
      error: 'Project setup on the selected automation host is setting-up.',
      errorCode: 'projectSetupNotReady',
      errorParams: { setupState: 'setting-up' },
      occurrenceCount: 2
    })

    updateAutomationRun(operations, {
      runId: 'r1',
      status: 'dispatch_failed',
      error: 'spawn failed'
    })
    expect(state.automationRuns[0]).not.toHaveProperty('errorCode')
    expect(state.automationRuns[0]).not.toHaveProperty('errorParams')
  })
})

it('certifies only the actual unique canonical replacement before flush reentry, never bulk or duplicate IDs', () => {
  const state = stateWithRuns([
    { id: 'r1', createdAt: 1 },
    { id: 'r2', createdAt: 2 }
  ])
  state.automations = []
  const mutations: (AutomationRunMutation | undefined)[] = []
  const operations: AutomationRunOperations = {
    state,
    recordManualRun: () => {},
    getWorkspaceDisplayName: () => null,
    recordAutomationRunsMutation: (_runs, mutation) => {
      mutations.push(mutation)
    },
    flush: () => {
      expect(mutations.at(-1)?.after).toBe(state.automationRuns)
      if (state.automationRuns[0].error !== 'nested') {
        updateAutomationRun(operations, { runId: 'r1', status: 'dispatched', error: 'nested' })
      }
    }
  }
  const before = state.automationRuns
  const run = updateAutomationRun(operations, { runId: 'r2', status: 'dispatched' })
  expect(mutations[0]).toEqual({
    before,
    after: mutations[1]!.before,
    previous: before[1],
    updated: run
  })
  expect(mutations[0]!.previous).toBe(before[1])
  expect(mutations[1]!.after).toBe(state.automationRuns)
  expect(mutations[0]!.after).not.toBe(state.automationRuns)
  operations.flush = () => {}
  let reenter = true
  operations.getWorkspaceDisplayName = () => {
    if (reenter) {
      reenter = false
      updateAutomationRun(operations, { runId: 'r1', status: 'pending' })
    }
    return null
  }
  updateAutomationRun(operations, { runId: 'r2', status: 'dispatched' })
  expect(mutations.at(-1)!.before).toBe(mutations.at(-2)!.after)
  expect(mutations.at(-1)!.previous).toBe(run)
  state.automationRuns = [run, run]
  updateAutomationRun(operations, { runId: 'r2', status: 'completed' })
  expect(mutations.at(-1)).toBeUndefined()
  expect(state.automationRuns.every((row) => row.status === 'completed')).toBe(true)
  state.automationRuns = state.automationRuns.map((row) => ({ ...row, workspaceId: 'wt' }))
  snapshotAutomationRunWorkspaceDisplayName(operations, { id: 'wt', hostId: 'local' }, 'renamed')
  expect(mutations.at(-1)).toBeUndefined()
})
