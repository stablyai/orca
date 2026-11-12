import { ProducerProgressStore } from '../../../../agent-hooks/server/producer-progress'
import { expect, it, vi } from 'vitest'
import { WorkerQuietSweep, type WorkerQuietObservation } from './worker-quiet-sweep'
import { reportWorkerQuiet, latestWorkerQuietNotice } from './worker-quiet-report'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'

it('only advises for a quiet working episode, respects tools, fallback, grace, and a single reminder', () => {
  const producer = new ProducerProgressStore()
  const event = {
    paneKey: 'worker',
    connectionId: null,
    hookEventName: 'PreToolUse',
    toolUseId: 'exec-2',
    payload: {
      state: 'working' as const,
      prompt: '',
      agentType: 'codex' as const,
      toolName: 'Bash'
    }
  }
  producer.observe({ ...event, toolAgentId: 'child-a' }, 0)
  producer.observe({ ...event, toolAgentId: 'child-b' }, 0)
  producer.observe({ ...event, toolAgentId: 'child-a', hookEventName: 'PostToolUseFailure' }, 1)
  producer.observe({ ...event, isReplay: true }, 99)
  expect(producer.get('worker')?.lastProducerEventAt).toBe(1)
  expect([...producer.get('worker')!.tools.values()]).toEqual([{ name: 'Bash', startedAt: 0 }])
  producer.observe({ ...event, toolAgentId: 'child-b', hookEventName: 'PostToolUse' }, 2)
  expect([...producer.get('worker')!.tools.values()]).toEqual([])
  const sent: { id: string; ordinal: number; at: number }[] = []
  const sweep = new WorkerQuietSweep(
    0,
    () => undefined,
    (row, notice) => {
      sent.push({ id: row.dispatchId, ordinal: notice.ordinal, at: notice.observedAt })
      return true
    }
  )
  let rows: WorkerQuietObservation[] = [
    { dispatchId: 'quiet', turnStartedAt: 0, working: true, lastProducerEventAt: 0 },
    {
      dispatchId: 'tool',
      turnStartedAt: 0,
      working: true,
      lastProducerEventAt: 0,
      tool: { name: 'Bash', startedAt: 0 }
    },
    { dispatchId: 'fallback', turnStartedAt: 0, working: true },
    { dispatchId: 'restored', turnStartedAt: 0, working: true, restoredUnconfirmed: true },
    { dispatchId: 'idle', turnStartedAt: 0, working: false, lastProducerEventAt: 0 }
  ]
  for (let now = 0; now <= 3_600_000; now += 60_000) {
    sweep.sweep(rows, now)
  }
  expect(sent).toEqual([
    { id: 'quiet', ordinal: 1, at: 900_000 },
    { id: 'quiet', ordinal: 2, at: 2_700_000 },
    { id: 'tool', ordinal: 1, at: 3_600_000 },
    { id: 'fallback', ordinal: 1, at: 3_600_000 }
  ])
  rows = [{ dispatchId: 'quiet', turnStartedAt: 0, working: true, lastProducerEventAt: 3_600_000 }]
  for (let now = 3_660_000; now <= 4_500_000; now += 60_000) {
    sweep.sweep(rows, now)
  }
  expect(sent.at(-1)).toEqual({ id: 'quiet', ordinal: 3, at: 4_500_000 })
  sweep.resume(4_560_000)
  sweep.sweep(rows, 4_560_000)
  // A laptop sleep and a clock rollback both restart grace, never count as silence.
  sweep.sweep(rows, 10_000_000)
  sweep.sweep(rows, 1_000_000)
  expect(sent).toHaveLength(5)
  rows = [{ ...rows[0]!, connectionId: 'reconnected' }]
  for (let now = 1_060_000; now <= 1_900_000; now += 60_000) {
    sweep.sweep(rows, now)
  }
  expect(sent).toHaveLength(5)
  rows = [{ ...rows[0]!, lastProducerEventAt: 1_900_000 }]
  sweep.sweep(rows, 1_960_000)
  for (let now = 2_020_000; now <= 2_800_000; now += 60_000) {
    sweep.sweep(rows, now)
  }
  expect(sent.at(-1)).toEqual({ id: 'quiet', ordinal: 4, at: 2_800_000 })
})

it('relays status/normal with deterministic ids and retains the turn ordinal across restart', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'quiet notices',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ spec: 'do work', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const target = {
      kind: 'remote' as const,
      attachment: { dispatch_id: dispatch.id, task_id: task.id }
    }
    const row = {
      dispatchId: dispatch.id,
      turnStartedAt: 0,
      working: true,
      lastProducerEventAt: 0,
      from: 'term_worker',
      agent: 'Codex'
    }
    const notice = {
      dispatchId: dispatch.id,
      turnStartedAt: 0,
      ordinal: 1,
      observedAt: 900_000,
      intervalMs: 900_000
    }
    expect(reportWorkerQuiet(db, target, row, notice, vi.fn())).toBe(true)
    expect(reportWorkerQuiet(db, target, row, notice, vi.fn())).toBe(true)
    expect(reportWorkerQuiet(db, { kind: 'local', dispatch }, row, notice, vi.fn())).toBe(true)
    const local = db.getUnreadRunMailbox(run.id, 100, ['status'])
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({ type: 'status', priority: 'normal' })
    const relay = db.listPendingFederationRelay(dispatch.id, 'to_home')
    expect(relay).toHaveLength(1)
    expect(JSON.parse(relay[0]!.payload)).toMatchObject({ type: 'status', priority: 'normal' })
    expect(JSON.parse(JSON.parse(relay[0]!.payload).payload).stopReason).toBeUndefined()
    expect(latestWorkerQuietNotice(db, dispatch.id)?.ordinal).toBe(1)
    const sent: number[] = []
    const restarted = new WorkerQuietSweep(
      1_000_000,
      (id) => latestWorkerQuietNotice(db, id),
      (_row, next) => {
        sent.push(next.ordinal)
        return true
      }
    )
    for (let now = 1_000_000; now <= 5_000_000; now += 60_000) {
      restarted.sweep([row], now)
    }
    expect(sent).toEqual([2])
  } finally {
    db.close()
  }
})
