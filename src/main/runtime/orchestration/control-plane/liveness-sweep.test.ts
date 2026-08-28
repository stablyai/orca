import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { OrchestrationDb } from '../db'
import type { DispatchContextRow } from '../types'
import { ControlPlaneStore } from './control-plane-store'
import { classifyWakeReason } from './coordinator-wake-events'
import { selectDispatchAgentStatus, toLivenessEvidence } from './dispatch-liveness-evidence'
import {
  LivenessSweepScheduler,
  listActiveDispatchesForRun,
  runLivenessSweep,
  type LivenessSignalSource
} from './liveness-sweep'
import { persistDispatchProviderSessionBinding } from './provider-session-identity'

const NOW = Date.now()
const TOKEN = 'token-liveness'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

function statusRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: 'do the work',
    paneKey: 'tab:leaf',
    terminalHandle: 'term_worker',
    launchToken: TOKEN,
    connectionId: null,
    receivedAt: NOW - 5_000,
    stateStartedAt: NOW - 60_000,
    ...overrides
  } as AgentStatusIpcPayload
}

function source(overrides: Partial<LivenessSignalSource> = {}): LivenessSignalSource {
  return {
    agentStatusSnapshot: () => [],
    inspectProcessLiveness: async () => 'live',
    approvedWaitUntil: () => null,
    ...overrides
  }
}

describe('B4 correction 2: evidence comes from real runtime signals', () => {
  function dispatch(overrides: Partial<DispatchContextRow> = {}): DispatchContextRow {
    return {
      id: 'ctx_1',
      run_id: 'run_1',
      task_id: 'task_1',
      contract_version: 1,
      launch_token_hash: TOKEN_HASH,
      assignee_handle: 'term_worker',
      assignee_pane_key: 'tab:leaf',
      capability_hash: null,
      process_incarnation: 'pty1:inc1',
      capability_revoked_at: null,
      status: 'dispatched',
      failure_count: 0,
      last_failure: null,
      termination_reason: null,
      depth: 1,
      dispatched_at: '2026-08-27T11:00:00.000Z',
      completed_at: null,
      created_at: '2026-08-27T11:00:00.000Z',
      last_heartbeat_at: null,
      ...overrides
    }
  }

  it('maps the hook row timestamp to last activity and its toolName to an active tool call', () => {
    const evidence = toLivenessEvidence({
      dispatch: dispatch(),
      agentStatus: statusRow({ toolName: 'Edit' }),
      processLiveness: 'live',
      approvedWaitUntilIso: null,
      terminalOwnership: 'owned',
      lastTerminalOutputAtMs: null,
      settled: false
    })
    expect(evidence.activeToolCall).toBe(true)
    expect(evidence.lastActivityAt).toBe(new Date(NOW - 5_000).toISOString())
    expect(evidence.processState).toBe('running')
    expect(evidence.terminalState).toBe('attached')
  })

  it('translates an unreachable process table to unknown, never to exited', () => {
    const evidence = toLivenessEvidence({
      dispatch: dispatch(),
      agentStatus: null,
      processLiveness: 'unverifiable',
      approvedWaitUntilIso: null,
      terminalOwnership: 'owned',
      lastTerminalOutputAtMs: null,
      settled: false
    })
    expect(evidence.processState).toBe('unknown')
    expect(evidence.providerExit).toBeNull()
  })

  it('reads a recorded signaled/exited termination as a provider exit', () => {
    expect(
      toLivenessEvidence({
        dispatch: dispatch({ termination_reason: 'signaled' }),
        agentStatus: null,
        processLiveness: 'exited',
        approvedWaitUntilIso: null,
        terminalOwnership: 'owned',
        lastTerminalOutputAtMs: null,
        settled: false
      }).providerExit
    ).toEqual({ code: null, signal: 'signaled' })
    // An operator close is a deliberate stop, not a crash.
    expect(
      toLivenessEvidence({
        dispatch: dispatch({ termination_reason: 'operator_close' }),
        agentStatus: null,
        processLiveness: 'exited',
        approvedWaitUntilIso: null,
        terminalOwnership: 'owned',
        lastTerminalOutputAtMs: null,
        settled: false
      }).providerExit
    ).toBeNull()
  })

  it('treats a released or user-owned pane as a closed terminal', () => {
    for (const ownership of ['released', 'user_owned']) {
      expect(
        toLivenessEvidence({
          dispatch: dispatch(),
          agentStatus: statusRow(),
          processLiveness: 'live',
          approvedWaitUntilIso: null,
          terminalOwnership: ownership,
          lastTerminalOutputAtMs: null,
          settled: false
        }).terminalState
      ).toBe('closed')
    }
  })

  it('reads the SQLite space-format dispatch timestamp as UTC, not as local time', () => {
    // Regression: Date.parse('2026-08-27 11:00:00') is LOCAL time in Node, so a
    // raw column would skew the stall window by the host's offset.
    const evidence = toLivenessEvidence({
      dispatch: dispatch({ dispatched_at: '2026-08-27 11:00:00' }),
      agentStatus: null,
      processLiveness: 'live',
      approvedWaitUntilIso: null,
      terminalOwnership: 'owned',
      lastTerminalOutputAtMs: null,
      settled: false
    })
    expect(evidence.lastActivityAt).toBe('2026-08-27T11:00:00Z')
    expect(Date.parse(evidence.lastActivityAt as string)).toBe(
      Date.parse('2026-08-27T11:00:00.000Z')
    )
  })

  it('prefers the hook row stamped with this exact Dispatch over a pane match', () => {
    const stamped = statusRow({
      receivedAt: NOW - 60_000,
      orchestration: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        processIncarnation: 'pty1:inc1',
        launchTokenHash: TOKEN_HASH
      }
    })
    const paneOnly = statusRow({ receivedAt: NOW, orchestration: undefined })
    expect(selectDispatchAgentStatus(dispatch(), [paneOnly, stamped])).toBe(stamped)
  })

  it('rejects missing/wrong launch tokens and a replacement process in the same pane', () => {
    const exact = statusRow({
      orchestration: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        processIncarnation: 'pty1:inc1',
        launchTokenHash: TOKEN_HASH
      }
    })
    expect(selectDispatchAgentStatus(dispatch(), [exact])).toBe(exact)
    expect(selectDispatchAgentStatus(dispatch(), [{ ...exact, launchToken: undefined }])).toBeNull()
    expect(
      selectDispatchAgentStatus(dispatch(), [{ ...exact, launchToken: 'replacement' }])
    ).toBeNull()
    expect(
      selectDispatchAgentStatus(dispatch(), [
        {
          ...exact,
          orchestration: { ...exact.orchestration!, processIncarnation: 'pty1:inc2' }
        }
      ])
    ).toBeNull()
  })

  it('never reads a model heartbeat: last_heartbeat_at is not an input', () => {
    const withHeartbeat = toLivenessEvidence({
      dispatch: dispatch({ last_heartbeat_at: new Date(NOW).toISOString(), dispatched_at: null }),
      agentStatus: null,
      processLiveness: 'live',
      approvedWaitUntilIso: null,
      terminalOwnership: 'owned',
      lastTerminalOutputAtMs: null,
      settled: false
    })
    expect(withHeartbeat.lastActivityAt).toBeNull()
  })
})

describe('B4 correction 2: the sweep is the production owner', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    // A recorded process incarnation is what makes the host probe meaningful;
    // without one the runtime honestly reports `unverifiable` instead of a stall.
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'claude',
        launch: {
          requested: { agent: 'claude', model: 'opus-5', effort: 'high' },
          effective: { agent: 'claude', model: 'opus-5', effort: 'high' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab:leaf',
      processIncarnation: 'pty1:inc1',
      launchTokenHash: TOKEN_HASH,
      worktreeId: 'repo::/tmp/liveness-worker',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    const row = db.getDispatchContextById(started.dispatch.id)!
    db.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run(new Date(NOW - 30 * 60 * 1000).toISOString(), row.id)
    return { task, dispatch: row, runId: row.run_id }
  }

  it('finds the active dispatches of a Run', () => {
    const { runId, dispatch } = setup()
    expect(listActiveDispatchesForRun(db, runId).map((row) => row.id)).toEqual([dispatch.id])
  })

  it('publishes a typed stalled escalation into the Run mailbox and notifies once', () => {
    const { runId, dispatch } = setup()
    const notify = vi.fn()
    return runLivenessSweep({
      db,
      runId,
      nowMs: NOW,
      publisher: { notifyMessageArrived: notify },
      source: source()
    }).then((result) => {
      expect(result.wakes).toEqual([
        expect.objectContaining({ dispatchId: dispatch.id, reason: 'stalled' })
      ])
      expect(result.publishedMessageIds).toHaveLength(1)
      expect(notify).toHaveBeenCalledWith(`run:${runId}`, 'escalation')
      const message = db.getMessageById(result.publishedMessageIds[0])
      expect(message?.type).toBe('escalation')
      expect(classifyWakeReason(message!)).toBe('stalled')
    })
  })

  it('is idempotent: a second sweep in the same state publishes nothing', async () => {
    const { runId } = setup()
    const stalled = source()
    await runLivenessSweep({ db, runId, nowMs: NOW, source: stalled })
    const second = await runLivenessSweep({ db, runId, nowMs: NOW + 1000, source: stalled })
    expect(second.wakes).toEqual([])
    expect(second.publishedMessageIds).toEqual([])
  })

  it('re-arms the marker expiry on every sweep', async () => {
    const { runId, dispatch } = setup()
    await runLivenessSweep({ db, runId, nowMs: NOW, source: source() })
    const first = new ControlPlaneStore(db).getLivenessMarker(dispatch.id)?.expires_at
    await runLivenessSweep({ db, runId, nowMs: NOW + 60_000, source: source() })
    const second = new ControlPlaneStore(db).getLivenessMarker(dispatch.id)?.expires_at
    expect(Date.parse(second as string)).toBeGreaterThan(Date.parse(first as string))
  })

  it('crashes terminally on a provider exit and never resurrects', async () => {
    const { runId, dispatch } = setup()
    db.failDispatch(dispatch.id, 'gone', {
      terminationReason: 'signaled',
      workerProcessExited: true
    })
    // A failed Dispatch is no longer active, so the sweep must not touch it.
    expect(listActiveDispatchesForRun(db, runId)).toEqual([])
    const result = await runLivenessSweep({ db, runId, nowMs: NOW, source: source() })
    expect(result.swept).toBe(0)
  })

  it('treats an active Orca-approved wait as live rather than stalled', async () => {
    const { runId, dispatch } = setup()
    const result = await runLivenessSweep({
      db,
      runId,
      nowMs: NOW,
      source: source({
        approvedWaitUntil: (id) =>
          id === dispatch.id ? new Date(NOW + 60_000).toISOString() : null
      })
    })
    expect(result.wakes).toEqual([])
    expect(new ControlPlaneStore(db).getLivenessMarker(dispatch.id)?.activity).toBe(
      'blocked_on_approved_wait'
    )
  })

  it('survives an execution host that throws, reporting unverifiable', async () => {
    const { runId, dispatch } = setup()
    await runLivenessSweep({
      db,
      runId,
      nowMs: NOW,
      source: source({
        inspectProcessLiveness: async () => {
          throw new Error('ssh down')
        }
      })
    })
    expect(new ControlPlaneStore(db).getLivenessMarker(dispatch.id)?.verdict).toBe('unverifiable')
  })

  it('marks the Dispatch crashed when the provider exits back to a still-live shell', async () => {
    const { runId, dispatch } = setup()
    const result = await runLivenessSweep({
      db,
      runId,
      nowMs: NOW,
      source: source({
        inspectProcessLiveness: async () => 'live',
        inspectProviderProcessLiveness: async () => 'exited',
        lastTerminalOutputAtMs: () => NOW
      })
    })
    expect(result.wakes).toEqual([
      expect.objectContaining({ dispatchId: dispatch.id, reason: 'crashed' })
    ])
    expect(new ControlPlaneStore(db).getLivenessMarker(dispatch.id)).toMatchObject({
      verdict: 'exited',
      activity: 'crashed'
    })
  })

  it('does not let a replacement provider session in the same PTY refresh the old Dispatch', async () => {
    const { runId, dispatch } = setup()
    expect(
      persistDispatchProviderSessionBinding(db, {
        dispatchId: dispatch.id,
        binding: {
          agent: 'claude',
          key: 'session_id',
          id: 'session-old',
          processIncarnation: 'pty1:inc1',
          observedAtMs: NOW - 10_000
        }
      })
    ).toBe(true)
    const exactStatus = statusRow({
      providerSession: { key: 'session_id', id: 'session-new' },
      orchestration: {
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        processIncarnation: 'pty1:inc1',
        launchTokenHash: TOKEN_HASH
      }
    })
    const result = await runLivenessSweep({
      db,
      runId,
      nowMs: NOW,
      source: source({
        agentStatusSnapshot: () => [exactStatus],
        inspectProviderProcessLiveness: async () => 'live',
        lastTerminalOutputAtMs: () => NOW
      })
    })
    expect(result.wakes).toEqual([
      expect.objectContaining({ dispatchId: dispatch.id, reason: 'crashed' })
    ])
  })
})

describe('B4 correction 2: scheduler shutdown', () => {
  it('starts once, is idempotent, and stops deterministically', () => {
    vi.useFakeTimers()
    try {
      const tick = vi.fn()
      const scheduler = new LivenessSweepScheduler(1_000, tick)
      scheduler.start()
      scheduler.start()
      expect(scheduler.running).toBe(true)
      vi.advanceTimersByTime(3_000)
      expect(tick).toHaveBeenCalledTimes(3)
      scheduler.stop()
      expect(scheduler.running).toBe(false)
      vi.advanceTimersByTime(5_000)
      expect(tick).toHaveBeenCalledTimes(3)
      // A second stop is a no-op, so a duplicated finally cannot throw.
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
