import { readFileSync } from 'node:fs'
import { ProducerProgressStore } from '../../../../agent-hooks/server/producer-progress'
import { expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../../agent-hooks/server/agent-hook-server'
import {
  buildBody,
  PANE,
  postHookEvent
} from '../../../../agent-hooks/server/testing/server.test-fixtures'
import {
  hookAt,
  loadCapture
} from '../../../../agent-hooks/server/testing/interruptions/claude-cancel-capture.test-fixture'
import { readQuietWorkers } from './worker-quiet-observations'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import { WorkerQuietSweep, type WorkerQuietObservation } from './worker-quiet-sweep'
import { reportWorkerQuiet } from './worker-quiet-report'
import { latestWorkerQuietNotices } from './worker-quiet-recovery'
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
    () => new Map(),
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
    expect(
      latestWorkerQuietNotices(db, [{ dispatchId: dispatch.id, runId: run.id }]).get(dispatch.id)
        ?.ordinal
    ).toBe(1)
    const sent: number[] = []
    const restarted = new WorkerQuietSweep(
      1_000_000,
      (ids) =>
        latestWorkerQuietNotices(
          db,
          ids.map((dispatchId) => ({ dispatchId, runId: run.id }))
        ),
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

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => undefined
  })
)

it('uses captured Claude call matching and shell monitoring for the longer advisory window', async () => {
  _internals.resetCachesForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_790_000_000_000)
  let server = new AgentHookServer()
  const db = new OrchestrationDb(':memory:')
  const capture = loadCapture('claude-cancel-shell-hooks')
  const run = db.createRun({
    objective: 'quiet capture',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: observation only reads connection status when a real hook row exists.
  const pty = { connected: true } as RuntimePtyWorktreeRecord
  const observation = () =>
    readQuietWorkers(
      {
        store: server,
        readPaneKeys: () => [PANE],
        readPty: () => pty,
        resolveTerminal: () => ({ db, handle: 'term_worker', target: { kind: 'local', dispatch } })
      },
      db
    )[0]!.observation
  const noticeTimes = (row: WorkerQuietObservation) => {
    const sent: number[] = []
    const sweep = new WorkerQuietSweep(
      Date.now(),
      () => new Map(),
      (_row, notice) => {
        sent.push(notice.observedAt - 1_790_000_000_000)
        return true
      }
    )
    for (let elapsed = 0; elapsed <= 3_600_000; elapsed += 60_000) {
      sweep.sweep([row], Date.now() + elapsed)
    }
    return sent
  }
  const post = async (index: number) => {
    const response = await postHookEvent(server, buildBody(hookAt(capture, index).payload))
    expect(response.status).toBe(204)
  }
  try {
    await server.start({ env: 'production' })
    await post(0)
    await post(1)
    await post(2)
    expect([...server.producerProgress.get(PANE)!.tools]).toEqual([
      ['["","toolu_019CFdP5Te6J1GaLQnPKGs7m"]', { name: 'Bash', startedAt: 1_790_000_000_000 }]
    ])
    expect(noticeTimes(observation())).toEqual([3_600_000])
    await post(3)
    expect([...server.producerProgress.get(PANE)!.tools]).toEqual([])
    expect(noticeTimes(observation())).toEqual([900_000, 2_700_000])
    await post(4)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring'
    })
    expect(observation().tool).toEqual({ name: 'background work', startedAt: 1_790_000_000_000 })
    expect(noticeTimes(observation())).toEqual([3_600_000])
    const taskHooks: { scenario: string; kind: string; payload?: Record<string, unknown> }[] =
      readFileSync(
        new URL(
          '../../../../../shared/__fixtures__/claude-task-notification-hooks.jsonl',
          import.meta.url
        ),
        'utf8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    for (const { scenario, through, expectedTool, notices } of [
      {
        scenario: 'one-subagent',
        through: 6,
        expectedTool: undefined,
        notices: [900_000, 2_700_000]
      },
      {
        scenario: 'two-subagents-together',
        through: 9,
        expectedTool: undefined,
        notices: [900_000, 2_700_000]
      },
      {
        scenario: 'subagent-with-own-shell',
        through: 10,
        expectedTool: { name: 'background work', startedAt: 1_790_000_000_000 },
        notices: [3_600_000]
      }
    ]) {
      server.stop()
      _internals.resetCachesForTests()
      server = new AgentHookServer()
      await server.start({ env: 'production' })
      const captured = taskHooks.filter(
        (hook) => hook.scenario === scenario && hook.kind === 'hook'
      )
      for (const hook of captured.slice(0, through + 1)) {
        const response = await postHookEvent(server, buildBody(hook.payload!))
        expect(response.status).toBe(204)
      }
      // Reduced child captures omit call IDs; only the shell inventory proves monitoring.
      expect([...server.producerProgress.get(PANE)!.tools]).toEqual([])
      expect(observation().tool).toEqual(expectedTool)
      expect(noticeTimes(observation())).toEqual(notices)
    }
  } finally {
    server.stop()
    db.close()
    vi.useRealTimers()
  }
})

it('retires captured Claude child calls at child stop without retiring the parent call', async () => {
  _internals.resetCachesForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_790_000_000_000)
  const server = new AgentHookServer()
  const capture: { childDenied: Record<string, unknown>[] } = JSON.parse(
    readFileSync(
      new URL(
        '../../../../claude/__fixtures__/claude-self-denied-permission-hooks.json',
        import.meta.url
      ),
      'utf8'
    )
  )
  const post = async (index: number) => {
    expect((await postHookEvent(server, buildBody(capture.childDenied[index]!))).status).toBe(204)
  }
  const calls = () => [...server.producerProgress.get(PANE)!.tools.keys()]
  try {
    await server.start({ env: 'production' })
    for (let index = 0; index <= 7; index++) {
      await post(index)
    }
    expect(calls()).toEqual([
      '["","toolu_01Di42VZZSD5BsDYgcx6keYQ"]',
      '["a1585ba7d93704919","toolu_01Dcj3M1WrcnrHYJdYrnhrEn"]'
    ])
    // A missed batch report leaves the denied child call open until its captured stop arrives.
    await post(9)
    expect(calls()).toEqual(['["","toolu_01Di42VZZSD5BsDYgcx6keYQ"]'])
    await post(10)
    expect(calls()).toEqual([])
  } finally {
    server.stop()
    vi.useRealTimers()
  }
})

vi.mock('../../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readOpenCodeBinderSessions: async () => []
}))

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
