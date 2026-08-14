import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { WedgedWorkerDetector, type WedgedWorkerObservationSource } from './wedged-worker-detector'
import { WEDGED_WORKER_SIGNAL_KIND } from './wedged-worker-escalation'
import type { WorkerPaneSample, WorkerProgressAssessment } from './worker-progress-evidence'
import {
  DEFAULT_WORKER_PROGRESS_THRESHOLDS,
  type WorkerProgressThresholds
} from './worker-progress-thresholds'

const MINUTE = 60_000
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const WORKER_HANDLE = 'term_worker'
const WORKER_INCARNATION = 'pty_worker:incarnation_1'

type Emission = {
  assessment: WorkerProgressAssessment
  escalationCount: number
  subject: string
  body: string
  payload: string
}

describe('WedgedWorkerDetector', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createRun(d: OrchestrationDb): string {
    return d.createRun({
      objective: 'supervise one worker',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:22222222-2222-4222-8222-222222222222'
    }).id
  }

  function startReadyWorker(
    d: OrchestrationDb,
    runId: string,
    options: { spec?: string; paneKey?: string; handle?: string } = {}
  ): { taskId: string; dispatchId: string } {
    const task = d.createTask({ spec: options.spec ?? 'do the work', runId })
    const started = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'claude' }
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: options.handle ?? WORKER_HANDLE,
      paneKey: options.paneKey ?? WORKER_PANE,
      processIncarnation: WORKER_INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  function startFederatedWorker(d: OrchestrationDb, runId: string): string {
    const task = d.createTask({ spec: 'work on the windows box', runId })
    const started = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { topology: 'new-top-level', agent: 'codex' },
      federation: {
        environmentId: 'env_windows',
        environmentName: 'windows',
        peerFingerprint: 'peer_windows',
        protocolVersion: 1
      }
    })
    d.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'ready',
      stage: 'input_accepted',
      terminalHandle: 'remote_term',
      worktreeId: 'remote::worktree'
    })
    return started.dispatch.id
  }

  function quietPane(atMs: number): WorkerPaneSample {
    return {
      connected: true,
      processIncarnation: WORKER_INCARNATION,
      lastOutputAtEpochMs: atMs,
      agentState: 'working',
      agentEventAtEpochMs: atMs,
      agentTurnStartedAtEpochMs: atMs
    }
  }

  function createDetector(
    d: OrchestrationDb,
    clock: { nowMs: number },
    source: Partial<WedgedWorkerObservationSource> = {}
  ): { detector: WedgedWorkerDetector; emissions: Emission[] } {
    const emissions: Emission[] = []
    const detector = new WedgedWorkerDetector({
      db: d,
      source: {
        samplePane: source.samplePane ?? (() => quietPane(clock.nowMs)),
        hasBlockingMailboxWait: source.hasBlockingMailboxWait ?? (() => false)
      },
      emit: ({ assessment, escalationCount, message }) => {
        emissions.push({
          assessment,
          escalationCount,
          subject: message.subject,
          body: message.body,
          payload: message.payload
        })
      },
      now: () => clock.nowMs
    })
    return { detector, emissions }
  }

  // Why a mailbox-writing emit: an emit that only records in memory hides the persisted
  // escalation row, which is what a later scan reads its cadence back from.
  function createMailboxDetector(
    d: OrchestrationDb,
    clock: { nowMs: number },
    samplePane: () => WorkerPaneSample | null,
    thresholds: WorkerProgressThresholds = DEFAULT_WORKER_PROGRESS_THRESHOLDS
  ): WedgedWorkerDetector {
    return new WedgedWorkerDetector({
      db: d,
      source: { samplePane, hasBlockingMailboxWait: () => false },
      thresholds,
      emit: ({ assessment, message }) => {
        d.insertMessage({
          runId: assessment.runId,
          from: `dispatch:${assessment.dispatchId}`,
          to: `run:${assessment.runId}`,
          subject: message.subject,
          body: message.body,
          type: 'escalation',
          priority: 'high',
          payload: message.payload
        })
      },
      now: () => clock.nowMs
    })
  }

  function mailboxEscalationCounts(d: OrchestrationDb, runId: string): number[] {
    return d
      .getUnreadMessages(`run:${runId}`, ['escalation'])
      .map((message) => JSON.parse(message.payload ?? '{}').wedgedWorker.escalationCount)
  }

  it('escalates exactly once when a ready worker stops producing any progress evidence', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId, taskId } = startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 40 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(startedAt)
    })

    expect(detector.scanOnce()).toMatchObject({ candidates: 1, escalated: 1 })
    expect(emissions).toHaveLength(1)
    expect(emissions[0]).toMatchObject({
      escalationCount: 1,
      assessment: {
        dispatchId,
        taskId,
        status: 'wedged',
        reason: 'no_progress_within_threshold'
      }
    })

    // Why: a second scan at the short interval must not wake the coordinator again.
    clock.nowMs += MINUTE
    expect(detector.scanOnce()).toMatchObject({ escalated: 0 })
    expect(emissions).toHaveLength(1)
  })

  it('re-escalates only on the long cadence and with a rising count', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 20 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(startedAt)
    })

    detector.scanOnce()
    clock.nowMs += DEFAULT_WORKER_PROGRESS_THRESHOLDS.reEscalateAfterMs - MINUTE
    detector.scanOnce()
    expect(emissions).toHaveLength(1)

    clock.nowMs += 2 * MINUTE
    detector.scanOnce()
    expect(emissions.map((emission) => emission.escalationCount)).toEqual([1, 2])
    expect(emissions[1].subject).toContain('may be wedged')
  })

  it('stops escalating and resets the count once progress resumes', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 16 * MINUTE }
    let lastOutputAtEpochMs = startedAt
    // Why a long re-escalation gap: it separates "recovered, then wedged again" from a
    // repeat of the first wedge. Only a discarded cadence escalates inside this window.
    const thresholds = {
      ...DEFAULT_WORKER_PROGRESS_THRESHOLDS,
      reEscalateAfterMs: 60 * MINUTE
    }
    const scan = (): void => {
      createMailboxDetector(d, clock, () => quietPane(lastOutputAtEpochMs), thresholds).scanOnce()
    }

    scan()
    expect(mailboxEscalationCounts(d, runId)).toEqual([1])

    // Why the clock moves first: the output has to land strictly after the escalation to
    // be progress at all. Before the payload carried the exact instant, this read back off
    // the row stamp — real wall-clock time, minutes behind this fake clock — and any
    // output looked later than the escalation whether it was or not.
    clock.nowMs += MINUTE
    lastOutputAtEpochMs = clock.nowMs
    scan()
    expect(mailboxEscalationCounts(d, runId)).toEqual([1])

    clock.nowMs += 20 * MINUTE
    scan()
    // Why 1 again, and why at all: the worker made progress after that escalation, so
    // this is a new wedge. Reading the stale persisted row would both suppress it
    // (inside the re-escalation gap) and mislabel it as escalation 2.
    expect(mailboxEscalationCounts(d, runId)).toEqual([1, 1])
  })

  it('leaves a worker that is still producing output alone', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const clock = { nowMs: Date.now() + 60 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(clock.nowMs - 30_000)
    })

    expect(detector.scanOnce()).toMatchObject({
      candidates: 1,
      escalated: 0,
      byStatus: expect.objectContaining({ working: 1 })
    })
    expect(emissions).toEqual([])
  })

  it('treats a worker blocked on an unanswered ask as alive', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId } = startReadyWorker(d, runId)
    d.createQuestion({
      runId,
      dispatchId,
      askerHandle: WORKER_HANDLE,
      question: 'Which base branch should I use?'
    })
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(startedAt)
    })

    expect(detector.scanOnce()).toMatchObject({
      escalated: 0,
      byStatus: expect.objectContaining({ blocked: 1 })
    })
    expect(emissions).toEqual([])
  })

  it('treats a worker parked in a blocking check --wait as alive', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId } = startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const waited: string[] = []
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(startedAt),
      hasBlockingMailboxWait: (id) => {
        waited.push(id)
        return true
      }
    })

    expect(detector.scanOnce()).toMatchObject({
      escalated: 0,
      byStatus: expect.objectContaining({ blocked: 1 })
    })
    expect(waited).toEqual([dispatchId])
    expect(emissions).toEqual([])
  })

  it('treats a harness that reports waiting on input as alive', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => ({ ...quietPane(startedAt), agentState: 'waiting' })
    })

    expect(detector.scanOnce()).toMatchObject({
      byStatus: expect.objectContaining({ blocked: 1 })
    })
    expect(emissions).toEqual([])
  })

  it('finds a worker that started after an emptiness probe cached no dispatches', () => {
    const d = createDb()
    const runId = createRun(d)
    // Why prime it: the agent-status publish path probes this on every frame, so a
    // cached `false` is the normal state when the first worker of a session starts.
    expect(d.hasAnyDispatchContexts()).toBe(false)

    startReadyWorker(d, runId)
    expect(d.hasAnyDispatchContexts()).toBe(true)
    expect(d.listSupervisedWorkerProgressRows()).toHaveLength(1)
  })

  it('ignores a settled dispatch entirely', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId, taskId } = startReadyWorker(d, runId)
    d.settleWorkerReport({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: JSON.stringify({ provenance: 'worker_report' })
    })
    const clock = { nowMs: Date.now() + 90 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => quietPane(Date.now())
    })

    expect(detector.scanOnce()).toMatchObject({ candidates: 0, escalated: 0 })
    expect(emissions).toEqual([])
  })

  it('classifies a missing or disconnected pane as unknown instead of wedged', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, { samplePane: () => null })
    expect(detector.scanOnce()).toMatchObject({
      escalated: 0,
      byStatus: expect.objectContaining({ unknown: 1 })
    })

    const disconnected = createDetector(d, clock, {
      samplePane: () => ({ ...quietPane(startedAt), connected: false })
    })
    expect(disconnected.detector.scanOnce()).toMatchObject({
      escalated: 0,
      byStatus: expect.objectContaining({ unknown: 1 })
    })
    expect([...emissions, ...disconnected.emissions]).toEqual([])
  })

  it('classifies a pane whose process was replaced as unknown', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => ({
        ...quietPane(startedAt),
        processIncarnation: 'pty_worker:incarnation_2'
      })
    })

    expect(detector.scanOnce()).toMatchObject({
      escalated: 0,
      byStatus: expect.objectContaining({ unknown: 1 })
    })
    expect(emissions).toEqual([])
  })

  it('classifies a pane with no verifiable process identity as unknown', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const quiet = { nowMs: startedAt + 90 * MINUTE }
    const busy = { nowMs: startedAt + MINUTE }
    // Why both clocks: an unverifiable identity must not read as wedged OR as working —
    // the pane's output cannot be attributed to this dispatch either way.
    for (const clock of [quiet, busy]) {
      const { detector, emissions } = createDetector(d, clock, {
        samplePane: () => ({ ...quietPane(startedAt), processIncarnation: null })
      })
      expect(detector.scanOnce()).toMatchObject({
        escalated: 0,
        byStatus: expect.objectContaining({ unknown: 1 })
      })
      expect(emissions).toEqual([])
    }
  })

  it('keeps an unverifiable identity unknown even when the harness reports waiting', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 90 * MINUTE }
    const { detector } = createDetector(d, clock, {
      samplePane: () => ({
        ...quietPane(startedAt),
        processIncarnation: null,
        agentState: 'waiting'
      })
    })

    expect(detector.scanOnce()).toMatchObject({
      byStatus: expect.objectContaining({ unknown: 1, blocked: 0 })
    })
  })

  it('classifies a federated dispatch as unknown without sampling local panes', () => {
    const d = createDb()
    const runId = createRun(d)
    const dispatchId = startFederatedWorker(d, runId)
    const clock = { nowMs: Date.now() + 90 * MINUTE }
    const sampled: (string | null)[] = []
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: (paneKey) => {
        sampled.push(paneKey)
        return null
      }
    })

    const summary = detector.scanOnce()
    expect(summary).toMatchObject({
      candidates: 1,
      escalated: 0,
      byStatus: expect.objectContaining({ unknown: 1 })
    })
    expect(emissions).toEqual([])
    expect(d.getFederatedDispatch(dispatchId)).toBeDefined()
    // Why: a federated worker has no local pane, so a null sample must not read as a wedge.
    expect(sampled).toEqual([null])
  })

  it('counts a heartbeat, a worker message and a worker question as progress evidence', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId } = startReadyWorker(d, runId)
    const heartbeatAt = new Date(Date.now() - MINUTE).toISOString()
    d.recordHeartbeat(dispatchId, heartbeatAt)
    const clock = { nowMs: Date.now() + 5 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, { samplePane: () => null })

    // Why unknown, not working: the pane is unobservable, and unknown never becomes working.
    expect(detector.scanOnce()).toMatchObject({
      byStatus: expect.objectContaining({ unknown: 1 })
    })

    const observed = createDetector(d, clock, {
      samplePane: () => ({
        connected: true,
        processIncarnation: WORKER_INCARNATION,
        lastOutputAtEpochMs: null,
        agentState: null,
        agentEventAtEpochMs: null,
        agentTurnStartedAtEpochMs: null
      })
    })
    expect(observed.detector.scanOnce()).toMatchObject({
      byStatus: expect.objectContaining({ working: 1 })
    })
    expect([...emissions, ...observed.emissions]).toEqual([])
  })

  it('resumes a rising count from a persisted escalation after a runtime restart', () => {
    const d = createDb()
    const runId = createRun(d)
    const { dispatchId } = startReadyWorker(d, runId)
    const startedAt = Date.now()
    // Why just past the threshold: the persisted escalation is stamped by the DB's own
    // clock, so the cadence only reads true if the detector's clock stays near it.
    const clock = { nowMs: startedAt + 16 * MINUTE }
    const emitToMailbox = (): WedgedWorkerDetector =>
      createMailboxDetector(d, clock, () => quietPane(startedAt))

    emitToMailbox().scanOnce()
    const mailbox = d.getUnreadMessages(`run:${runId}`, ['escalation'])
    expect(mailbox).toHaveLength(1)
    const payload = JSON.parse(mailbox[0].payload ?? '{}')
    expect(payload).toMatchObject({
      kind: WEDGED_WORKER_SIGNAL_KIND,
      wedgedWorker: {
        dispatchId,
        escalationCount: 1,
        detectionOnly: true,
        // Why the payload and not the row stamp: `created_at` truncates to whole
        // seconds, and a restart reads the cadence back off this record.
        escalatedAtEpochMs: clock.nowMs
      }
    })
    // Why: the retired coordinator loop fails a dispatch on a top-level payload.taskId,
    // so this signal must never expose one.
    expect(payload.taskId).toBeUndefined()

    // A fresh detector stands in for a restarted runtime with no in-memory cadence.
    clock.nowMs += MINUTE
    emitToMailbox().scanOnce()
    expect(d.getUnreadMessages(`run:${runId}`, ['escalation'])).toHaveLength(1)

    clock.nowMs += DEFAULT_WORKER_PROGRESS_THRESHOLDS.reEscalateAfterMs
    emitToMailbox().scanOnce()
    const escalations = d.getUnreadMessages(`run:${runId}`, ['escalation'])
    expect(
      escalations.map((message) => JSON.parse(message.payload ?? '{}').wedgedWorker.escalationCount)
    ).toEqual([1, 2])
  })

  it('reports what it did and did not observe, and says it took no action', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const clock = { nowMs: startedAt + 45 * MINUTE }
    const { detector, emissions } = createDetector(d, clock, {
      samplePane: () => ({
        connected: true,
        processIncarnation: WORKER_INCARNATION,
        lastOutputAtEpochMs: startedAt,
        agentState: 'working',
        agentEventAtEpochMs: null,
        agentTurnStartedAtEpochMs: null
      })
    })

    detector.scanOnce()
    expect(emissions[0].assessment.observed).toEqual(['terminal_output'])
    expect(emissions[0].assessment.absent).toContain('agent_turn_boundary')
    expect(emissions[0].body).toContain('detection signal only')
    expect(emissions[0].body).toContain('checkpoint rather than a failure')
  })

  it('does nothing at all when detection is disabled', () => {
    const d = createDb()
    const runId = createRun(d)
    startReadyWorker(d, runId)
    const startedAt = Date.now()
    const emissions: Emission[] = []
    const detector = new WedgedWorkerDetector({
      db: d,
      source: {
        samplePane: () => quietPane(startedAt),
        hasBlockingMailboxWait: () => false
      },
      emit: ({ assessment, escalationCount, message }) => {
        emissions.push({ assessment, escalationCount, ...message })
      },
      thresholds: { ...DEFAULT_WORKER_PROGRESS_THRESHOLDS, enabled: false },
      now: () => startedAt + 90 * MINUTE
    })

    expect(detector.scanOnce()).toMatchObject({ candidates: 0, escalated: 0 })
    expect(emissions).toEqual([])
  })
})
