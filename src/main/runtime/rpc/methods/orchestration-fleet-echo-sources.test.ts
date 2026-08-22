import { describe, it, expect } from 'vitest'
import {
  attachFleetEcho,
  createFleetEchoRuntimeDeps,
  createFleetEchoSources,
  type FleetEchoRuntimeDeps
} from './orchestration-fleet-echo-sources'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

const NOW = 500_000

function makeTerminalSummary(
  handle: string,
  overrides: Partial<RuntimeTerminalSummary> = {}
): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: 'pty_1',
    worktreeId: 'wt_1',
    worktreePath: '/wt',
    branch: 'main',
    tabId: 'tab_1',
    leafId: 'leaf_1',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: NOW - 2_000,
    preview: '',
    ...overrides
  }
}

function makeDeps(overrides: Partial<FleetEchoRuntimeDeps> = {}): FleetEchoRuntimeDeps {
  return {
    listActiveDispatchesForRun: () => [
      {
        id: 'ctx_1',
        task_id: 'task_1',
        assignee_handle: 'term_a',
        status: 'dispatched',
        dispatched_at: '2026-08-16 00:00:00',
        last_heartbeat_at: null
      }
    ],
    getWorkerDispatchStage: () => 'input_accepted',
    getTerminalSignal: () => ({ lastOutputAt: NOW - 2_000, processState: 'live' }),
    now: () => NOW,
    ...overrides
  }
}

describe('createFleetEchoSources', () => {
  it('maps snake_case dispatch rows onto the builder shape', () => {
    const sources = createFleetEchoSources(makeDeps(), 'run_1')

    expect(sources.listActiveDispatches()).toEqual([
      {
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        assigneeHandle: 'term_a',
        status: 'dispatched',
        dispatchedAt: Date.parse('2026-08-16T00:00:00.000Z'),
        lastHeartbeatAt: null
      }
    ])
  })

  it('normalizes a heartbeat timestamp through the same UTC path as dispatched_at', () => {
    const sources = createFleetEchoSources(
      makeDeps({
        listActiveDispatchesForRun: () => [
          {
            id: 'ctx_1',
            task_id: 'task_1',
            assignee_handle: 'term_a',
            status: 'dispatched',
            dispatched_at: '2026-08-16 00:00:00',
            // Why: SQLite writes timezone-less UTC; read as local time this lane would report an
            // age wrong by the host offset, which is the #8452 failure applied to a second column.
            last_heartbeat_at: '2026-08-16 00:04:00'
          }
        ]
      }),
      'run_1'
    )

    expect(sources.listActiveDispatches()[0].lastHeartbeatAt).toBe(
      Date.parse('2026-08-16T00:04:00.000Z')
    )
  })

  it('drops rows whose status is not an active lifecycle', () => {
    const sources = createFleetEchoSources(
      makeDeps({
        listActiveDispatchesForRun: () => [
          {
            id: 'ctx_1',
            task_id: 'task_1',
            assignee_handle: 'term_a',
            status: 'completed',
            dispatched_at: null,
            last_heartbeat_at: null
          }
        ]
      }),
      'run_1'
    )

    expect(sources.listActiveDispatches()).toEqual([])
  })

  it('maps an unparseable dispatch timestamp to null rather than NaN', () => {
    const sources = createFleetEchoSources(
      makeDeps({
        listActiveDispatchesForRun: () => [
          {
            id: 'ctx_1',
            task_id: 'task_1',
            assignee_handle: 'term_a',
            status: 'dispatched',
            dispatched_at: 'not a timestamp',
            last_heartbeat_at: null
          }
        ]
      }),
      'run_1'
    )

    expect(sources.listActiveDispatches()[0].dispatchedAt).toBeNull()
  })

  // Why: SQLite's datetime('now') writes timezone-less UTC; V8's Date.parse reads that as
  // local time, so west of UTC every dispatch --inject lane would read as dispatched in the
  // future and permanently report NOT_ACCEPTED (#8452).
  it('parses SQLite space-format timestamps as UTC regardless of the process TZ', () => {
    const originalTz = process.env.TZ
    process.env.TZ = 'America/Sao_Paulo'
    try {
      const sources = createFleetEchoSources(
        makeDeps({
          listActiveDispatchesForRun: () => [
            {
              id: 'ctx_1',
              task_id: 'task_1',
              assignee_handle: 'term_a',
              status: 'dispatched',
              dispatched_at: '2026-08-16 00:00:00',
              last_heartbeat_at: null
            }
          ]
        }),
        'run_1'
      )

      expect(sources.listActiveDispatches()[0].dispatchedAt).toBe(
        Date.parse('2026-08-16T00:00:00.000Z')
      )
    } finally {
      // Why: assigning an undefined back would set the literal string "undefined" and leak into sibling tests in this worker.
      if (originalTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = originalTz
      }
    }
  })
})

type FakeDispatchRow = {
  id: string
  task_id: string
  assignee_handle: string | null
  status: string
  dispatched_at: string | null
  last_heartbeat_at: string | null
}

function makeRuntime(
  overrides: {
    rows?: FakeDispatchRow[]
    stage?: string | null
    summaries?: RuntimeTerminalSummary[]
    throwOnList?: boolean
  } = {}
) {
  const rows = overrides.rows ?? [
    {
      id: 'ctx_1',
      task_id: 'task_1',
      assignee_handle: 'term_a',
      status: 'dispatched',
      dispatched_at: '2026-08-16 00:00:00',
      last_heartbeat_at: null
    }
  ]
  return {
    getOrchestrationDb: () => ({
      listActiveDispatchesForRun: () => {
        if (overrides.throwOnList) {
          throw new Error('db is busy')
        }
        return rows
      },
      getWorkerDispatch: () =>
        overrides.stage === null ? undefined : { stage: overrides.stage ?? 'input_accepted' }
    }),
    listTerminalSummariesForHandles: async () => overrides.summaries ?? [makeTerminalSummary('term_a')]
  }
}

describe('createFleetEchoRuntimeDeps', () => {
  it('returns null signals for a handle the runtime does not know', () => {
    const deps = createFleetEchoRuntimeDeps(makeRuntime() as never, new Map())

    expect(deps.getTerminalSignal('term_missing')).toBeNull()
  })

  it('looks up a pre-resolved signal by handle', () => {
    const signals = new Map([['term_a', { lastOutputAt: 1, processState: 'live' as const }]])
    const deps = createFleetEchoRuntimeDeps(makeRuntime() as never, signals)

    expect(deps.getTerminalSignal('term_a')).toEqual({ lastOutputAt: 1, processState: 'live' })
  })

  it('reads the worker stage through getWorkerDispatch', () => {
    const deps = createFleetEchoRuntimeDeps(makeRuntime({ stage: 'started' }) as never, new Map())

    expect(deps.getWorkerDispatchStage('ctx_1')).toBe('started')
  })

  it('returns null when the dispatch has no worker row', () => {
    const deps = createFleetEchoRuntimeDeps(makeRuntime({ stage: null }) as never, new Map())

    expect(deps.getWorkerDispatchStage('ctx_1')).toBeNull()
  })
})

describe('attachFleetEcho', () => {
  it('adds the block when enabled and a run is bound', async () => {
    const result = await attachFleetEcho(makeRuntime() as never, 'run_1', true, { ok: true })

    expect(result.ok).toBe(true)
    expect(result.fleet?.runId).toBe('run_1')
    expect(result.fleet?.lanes).toHaveLength(1)
    expect(result.fleet?.lanes[0]).toMatchObject({ handle: 'term_a' })
  })

  // Why: a connected PTY proves the shell is alive, not the agent process inside it — a
  // coordinator reading 'live' here would wrongly conclude a dead worker is fine.
  it('never reports live: a connected terminal is unknown, not live', async () => {
    const result = await attachFleetEcho(
      makeRuntime({ summaries: [makeTerminalSummary('term_a', { connected: true })] }) as never,
      'run_1',
      true,
      { ok: true }
    )

    expect(result.fleet?.lanes[0].processState).toBe('unknown')
  })

  it('marks a lane dead when its local terminal is disconnected', async () => {
    const result = await attachFleetEcho(
      makeRuntime({ summaries: [makeTerminalSummary('term_a', { connected: false })] }) as never,
      'run_1',
      true,
      { ok: true }
    )

    expect(result.fleet?.lanes[0].processState).toBe('dead')
  })

  it('marks a federated lane unknown since its handle never resolves locally', async () => {
    const result = await attachFleetEcho(makeRuntime({ summaries: [] }) as never, 'run_1', true, {
      ok: true
    })

    expect(result.fleet?.lanes[0].processState).toBe('unknown')
  })

  it('leaves the result untouched when disabled', async () => {
    const result = await attachFleetEcho(makeRuntime() as never, 'run_1', false, { ok: true })

    expect(result).toEqual({ ok: true })
  })

  it('leaves the result untouched when no run is bound', async () => {
    const result = await attachFleetEcho(makeRuntime() as never, null, true, { ok: true })

    expect(result).toEqual({ ok: true })
  })

  it('never fails the command when the sources throw', async () => {
    const result = await attachFleetEcho(makeRuntime({ throwOnList: true }) as never, 'run_1', true, {
      ok: true
    })

    expect(result).toEqual({ ok: true })
  })
})
