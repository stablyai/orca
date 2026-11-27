import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { AgentOrchestrationSnapshotRevision } from './agent-orchestration-snapshot-revision'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'

const ctx = (dispatchId: string, parentPaneKey?: string): AgentStatusOrchestrationContext => ({
  taskId: `task-${dispatchId}`,
  dispatchId,
  ...(parentPaneKey ? { parentPaneKey } : {})
})

describe('AgentOrchestrationSnapshotRevision', () => {
  it('shares one projection build across subscribers and omits unchanged contexts', () => {
    let now = 1_000
    let builds = 0
    let current: Record<string, AgentStatusOrchestrationContext> | undefined = {
      'tab:a': ctx('d1', 'tab:coord'),
      'tab:b': ctx('d2', 'tab:coord')
    }
    const snapshot = new AgentOrchestrationSnapshotRevision(
      () => {
        builds += 1
        return current
      },
      { maxContexts: 2, cacheTtlMs: 1_000, now: () => now }
    )

    // Two subscribers arriving together share a single build.
    const first = snapshot.since()
    const second = snapshot.since()
    expect(builds).toBe(1)
    expect(first).toEqual({ revision: 1, contexts: current })
    expect(second).toEqual({ revision: 1, contexts: current })

    // Re-asking at the current revision skips building and omits contexts.
    now += 200
    expect(snapshot.since(1)).toEqual({ revision: 1, unchanged: true })
    expect(builds).toBe(1)

    // After invalidation with identical projected contexts, revision stays unchanged.
    snapshot.invalidate()
    expect(snapshot.since(1)).toEqual({ revision: 1, unchanged: true })
    expect(builds).toBe(2)

    // After invalidation with a lineage change, revision advances, cap applies, and subscribers share the build.
    current = {
      'tab:a': ctx('d1', 'tab:coord'),
      'tab:b': ctx('d2-next', 'tab:coord'),
      'tab:c': ctx('d3', 'tab:coord')
    }
    snapshot.invalidate()
    const updated = snapshot.since(1)
    const secondUpdated = snapshot.since(1)
    expect(builds).toBe(3)
    expect(updated).toEqual({
      revision: 2,
      contexts: {
        'tab:a': ctx('d1', 'tab:coord'),
        'tab:b': ctx('d2-next', 'tab:coord')
      }
    })
    expect(secondUpdated).toEqual(updated)
  })
})

describe('OrchestrationDb.recordHeartbeat', () => {
  it('updates last_heartbeat_at without firing workerStatusListener', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'test run',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:coord'
      })
      const task = db.createTask({ runId: run.id, spec: 'worker task' })
      const dispatch = db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: 'worker-1',
        creator: { kind: 'system' },
        maxDepth: 2
      })

      const notices: { dispatchId: string | null; change: string }[] = []
      db.workerStatusListener = (dispatchId, change) => {
        notices.push({ dispatchId, change })
      }

      const heartbeatAt = '2026-11-25T18:00:00.000Z'
      db.recordHeartbeat(dispatch.id, heartbeatAt)
      expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBe(heartbeatAt)
      expect(notices).toEqual([])

      db.completeDispatch(dispatch.id)
      expect(notices.some((notice) => notice.dispatchId === dispatch.id)).toBe(true)
    } finally {
      db.close()
    }
  })
})
