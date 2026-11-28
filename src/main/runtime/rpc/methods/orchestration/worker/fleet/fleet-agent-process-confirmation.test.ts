import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { FleetAgentStatusEvidence } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { AgentProcessVerdict } from '../../../../../../../shared/agent-status/process/agent-process-presence'
import { projectWorkerFleet } from './worker-list-projection'
import { confirmStaleWorkerAgentProcesses } from './fleet-agent-process-confirmation'

const PANE = 'tab:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
const OTHER_PANE = 'tab:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
const NOW = Date.parse('2026-11-28T12:00:00Z')
const STALE_AT = NOW - 31 * 60 * 1000

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

/** A supervised worker parked at its prompt: ready, no worker_done, one owned terminal. */
function idleWorker(): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'wait for mail' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'claude' }
  })
  db.db
    .prepare(
      "UPDATE worker_dispatches SET state = 'ready', agent_terminal_handle = 'term_1' WHERE dispatch_id = ?"
    )
    .run(dispatch.id)
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
          process_incarnation, ownership_state, release_state)
       VALUES ('res_1', ?, ?, 'term_1', ?, 'proc_1', 'owned', 'not_requested')`
    )
    .run(dispatch.id, dispatch.id, PANE)
  return dispatch.id
}

function evidence(
  dispatchId: string,
  overrides: Partial<FleetAgentStatusEvidence['activity']> = {},
  clockAt = STALE_AT
): FleetAgentStatusEvidence {
  return {
    binding: {
      kind: 'worker',
      dispatchId,
      terminalHandle: 'term_1',
      paneKey: PANE,
      processIncarnation: 'proc_1'
    },
    clock: { kind: 'observed', at: clockAt },
    deliveredAt: 10,
    activity: {
      paneKey: PANE,
      connectionId: null,
      state: 'done',
      agentType: 'claude',
      model: null,
      worktreeId: null,
      restoredUnconfirmed: false,
      providerSessionOnly: false,
      ...overrides
    }
  }
}

function project(dispatchId: string, statuses: readonly FleetAgentStatusEvidence[]) {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  return projectWorkerFleet({
    rows,
    attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], NOW),
    statuses,
    limit: 1,
    now: NOW
  }).workers[0]
}

function confirm(
  dispatchId: string,
  statuses: readonly FleetAgentStatusEvidence[],
  verdict: AgentProcessVerdict | null = 'live',
  options: { throws?: boolean } = {}
) {
  const rows = db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  const checkPresence = vi.fn(async () => {
    if (options.throws) {
      throw new Error('ps failed')
    }
    return verdict
  })
  return {
    checkPresence,
    result: confirmStaleWorkerAgentProcesses({
      rows,
      attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], NOW),
      statuses,
      now: NOW,
      checkPresence
    })
  }
}

describe('a quiet idle worker whose hook clock passed the stale window', () => {
  it('stays live when its recorded process answers the re-probe', async () => {
    const dispatchId = idleWorker()
    const stale = evidence(dispatchId)
    const { checkPresence, result } = confirm(dispatchId, [stale])
    const statuses = await result

    expect(checkPresence).toHaveBeenCalledWith(PANE)
    expect(statuses[0]?.processConfirmedAt).toBe(NOW)
    const worker = project(dispatchId, statuses)
    expect(worker.liveness).toEqual({ verdict: 'live', observedAt: NOW, source: 'agent_status' })
    expect(worker.stage.activity).toBe('done')
    expect(worker.evidence.liveStatus).toBe('fresh')
    // The hook clock is not restamped; the row is still dated by its own evidence.
    expect(worker.evidence.lastObservedAt).toBe(STALE_AT)
    expect(worker.attention.categories).not.toContain('stale')
    expect(worker.attention.categories).not.toContain('unverifiable')
  })

  it('stays live for a turn still running behind a long background wait', async () => {
    const dispatchId = idleWorker()
    const working = evidence(dispatchId, { state: 'working' })
    const statuses = await confirm(dispatchId, [working]).result

    expect(project(dispatchId, statuses).liveness.verdict).toBe('live')
  })

  it.each(['exited', 'unverifiable', null] as const)(
    'stays stale when the probe answers %s',
    async (verdict) => {
      const dispatchId = idleWorker()
      const statuses = await confirm(dispatchId, [evidence(dispatchId)], verdict).result
      const worker = project(dispatchId, statuses)

      expect(statuses[0]?.processConfirmedAt).toBeUndefined()
      expect(worker.liveness).toEqual({
        verdict: 'unverifiable',
        reason: 'stale_status',
        observedAt: STALE_AT
      })
      expect(worker.attention.categories).toContain('stale')
    }
  )

  it('stays stale when the probe throws', async () => {
    const dispatchId = idleWorker()
    const { result } = confirm(dispatchId, [evidence(dispatchId)], 'live', { throws: true })
    const statuses = await result

    expect(statuses[0]?.processConfirmedAt).toBeUndefined()
    expect(project(dispatchId, statuses).liveness.verdict).toBe('unverifiable')
  })

  it('never upgrades a wait or a block, even with a live process', async () => {
    const dispatchId = idleWorker()
    for (const state of ['waiting', 'blocked'] as const) {
      const waiting = evidence(dispatchId, { state })
      const { checkPresence, result } = confirm(dispatchId, [waiting])
      const statuses = await result
      expect(checkPresence).not.toHaveBeenCalled()
      expect(statuses[0]?.processConfirmedAt).toBeUndefined()
      expect(project(dispatchId, [{ ...waiting, processConfirmedAt: NOW }]).liveness).toMatchObject(
        { verdict: 'unverifiable', reason: 'stale_status' }
      )
    }
  })

  it('keeps a hydrated unconfirmed row unconfirmed', () => {
    const dispatchId = idleWorker()
    const restored = {
      ...evidence(dispatchId, { restoredUnconfirmed: true }),
      processConfirmedAt: NOW
    }

    expect(project(dispatchId, [restored]).liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'restored_unconfirmed'
    })
  })

  it('does not probe fresh evidence, non-worker panes, or remote connections', async () => {
    const dispatchId = idleWorker()
    const fresh = evidence(dispatchId, {}, NOW - 60_000)
    const unrelated: FleetAgentStatusEvidence = {
      binding: {
        kind: 'pane',
        terminalHandle: 'term_other',
        paneKey: OTHER_PANE,
        processIncarnation: 'proc_other'
      },
      clock: { kind: 'observed', at: STALE_AT },
      deliveredAt: 10,
      activity: { ...evidence(dispatchId).activity, paneKey: OTHER_PANE }
    }
    const remote = evidence(dispatchId, { connectionId: 'ssh-host' })
    const { checkPresence, result } = confirm(dispatchId, [fresh, unrelated, remote])
    const statuses = await result

    expect(checkPresence).not.toHaveBeenCalled()
    expect(statuses.every((status) => status.processConfirmedAt === undefined)).toBe(true)
  })

  it('expires a confirmation older than the stale window', () => {
    const dispatchId = idleWorker()
    const expired = { ...evidence(dispatchId), processConfirmedAt: NOW - 31 * 60 * 1000 }

    expect(project(dispatchId, [expired]).liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'stale_status'
    })
  })
})
