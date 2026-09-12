import { describe, expect, it, vi } from 'vitest'
import {
  assignmentCleanupSteps,
  runAssignmentCleanup,
  type AssignmentCleanupStore
} from './assignment-cleanup-steps.js'

function stubStore(overrides: Partial<AssignmentCleanupStore> = {}) {
  const calls: string[] = []
  const method = (name: string) =>
    vi.fn(async () => {
      calls.push(name)
    })
  const store: AssignmentCleanupStore = {
    refreshRegionalRehomeLeases: method('refreshRegionalRehomeLeases'),
    completeReadyEvacuations: method('completeReadyEvacuations'),
    completeReadyRegionalRehomes: method('completeReadyRegionalRehomes'),
    abortExpiredEvacuations: method('abortExpiredEvacuations'),
    abortExpiredRegionalRehomes: method('abortExpiredRegionalRehomes'),
    reapRegionalRehomeAttempts: method('reapRegionalRehomeAttempts'),
    releaseExpiredActivityLeases: method('releaseExpiredActivityLeases'),
    releaseExpiredActivity: method('releaseExpiredActivity'),
    releaseExpiredRegionPreferences: method('releaseExpiredRegionPreferences'),
    evacuateDeadCells: method('evacuateDeadCells'),
    ...overrides
  }
  return { store, calls }
}

describe('assignment cleanup steps', () => {
  it('runs every later sweep when an early one fails, naming the step', async () => {
    const { store, calls } = stubStore({
      completeReadyRegionalRehomes: vi.fn(async () => {
        throw new Error('regional_rehome_assignment_mismatch')
      })
    })
    const warn = vi.fn()

    await runAssignmentCleanup(store, warn)

    expect(calls).toEqual([
      'refreshRegionalRehomeLeases',
      'completeReadyEvacuations',
      'abortExpiredEvacuations',
      'abortExpiredRegionalRehomes',
      'reapRegionalRehomeAttempts',
      'releaseExpiredActivityLeases',
      'releaseExpiredActivity',
      'releaseExpiredRegionPreferences',
      'evacuateDeadCells'
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(
      '[orca-relay] assignment cleanup failed: complete-ready-regional-rehomes'
    )
  })

  it('covers all ten sweeps exactly once per run', async () => {
    const { store, calls } = stubStore()

    await runAssignmentCleanup(store)

    expect(calls).toHaveLength(10)
    expect(new Set(calls).size).toBe(10)
    expect(assignmentCleanupSteps(store)).toHaveLength(10)
  })
})
