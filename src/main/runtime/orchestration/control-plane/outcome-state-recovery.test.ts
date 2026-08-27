import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import type { MessageRow } from '../types'
import { ControlPlaneStore } from './control-plane-store'
import { sweepDispatchLiveness } from './dispatch-liveness'
import { admitOutcome } from './outcome-identity'
import { describeOutcomeState } from './outcome-state-recovery'
import { requiredEvidenceKinds, type RouteEvidence } from './route-certification-evidence'
import { routeKey, type RouteIdentity } from './route-registry-types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const IDENTITY: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }

function passingEvidence(): RouteEvidence[] {
  return requiredEvidenceKinds('fresh').map((kind) => ({
    routeKey: routeKey(IDENTITY),
    kind,
    role: 'builder' as const,
    sessionMode: 'fresh' as const,
    outcome: 'PASS' as const,
    observedAt: '2026-08-27T11:00:00.000Z',
    runtimeVersion: '1.4.188',
    commitSha: 'abc1234',
    detail: null
  }))
}

describe('B10 one bounded state query', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'ship the thing' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    admitOutcome(store, {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Ship the thing',
      fingerprint: 'f1'
    })
    // Re-read: creating the Dispatch advances the Task row.
    return { store, task: db.getTask(task.id)!, dispatch }
  }

  function message(overrides: Partial<MessageRow>): MessageRow {
    return {
      id: 'msg_1',
      run_id: 'run_1',
      from_handle: 'term_worker',
      to_handle: 'run:run_1',
      subject: 'subject',
      body: '',
      type: 'status',
      priority: 'normal',
      thread_id: null,
      payload: null,
      read: 0,
      sequence: 1,
      created_at: '2026-08-27T11:59:00.000Z',
      delivered_at: null,
      sender_pane_key: null,
      ...overrides
    } as MessageRow
  }

  it('returns identity, lifecycle, liveness, route, gate and next actions in one record', () => {
    const { store, task, dispatch } = setup()
    sweepDispatchLiveness(
      store,
      [
        {
          dispatchId: dispatch.id,
          evidence: {
            processState: 'running',
            lastActivityAt: '2026-08-27T11:59:30.000Z',
            activeToolCall: false,
            approvedBlockingWaitUntil: null,
            providerExit: null,
            terminalState: 'attached'
          }
        }
      ],
      NOW
    )
    const report = describeOutcomeState(
      { runId: task.run_id, taskId: task.id, dispatchId: dispatch.id },
      {
        store,
        task,
        dispatch,
        recentMessages: [message({ type: 'heartbeat' })],
        routeEvidence: passingEvidence(),
        routeIdentity: IDENTITY,
        nowMs: NOW
      }
    )
    expect(report.identity).toMatchObject({
      outcomeId: 'out_1',
      runId: task.run_id,
      taskId: task.id,
      dispatchId: dispatch.id,
      legacyUnbound: false
    })
    expect(report.lifecycle).toMatchObject({
      outcomeStatus: 'admitted',
      taskStatus: 'dispatched',
      dispatchStatus: 'dispatched'
    })
    expect(report.liveness).toMatchObject({ verdict: 'live', activity: 'working' })
    expect(report.route).toMatchObject({ routeKey: 'claude|opus-5|high', certification: 'PASS' })
    expect(report.completionGate).toMatchObject({ required: true, satisfied: false })
    // A heartbeat is not a meaningful event, so the only legal move is to wait.
    expect(report.lastMeaningfulEvent).toBeNull()
    expect(report.nextLegalActions).toEqual(['wait_for_wake'])
  })

  it('names the exact next legal action for each wake reason', () => {
    const { store, task, dispatch } = setup()
    const build = (msg: MessageRow) =>
      describeOutcomeState(
        { runId: task.run_id, taskId: task.id, dispatchId: dispatch.id },
        {
          store,
          task,
          dispatch,
          recentMessages: [msg],
          routeEvidence: passingEvidence(),
          routeIdentity: IDENTITY,
          nowMs: NOW
        }
      )
    expect(build(message({ type: 'question' })).nextLegalActions).toEqual(['answer_question'])
    expect(build(message({ type: 'escalation' })).nextLegalActions).toEqual(['resolve_escalation'])
    expect(
      build(message({ type: 'escalation', payload: '{"wakeReason":"crashed"}' })).nextLegalActions
    ).toEqual(['resolve_escalation'])
    expect(build(message({ type: 'worker_done' })).nextLegalActions).toEqual(['validate_completion'])
  })

  it('reports a route whose certification is not current and offers recertification', () => {
    const { store, task, dispatch } = setup()
    const report = describeOutcomeState(
      { runId: task.run_id, taskId: task.id, dispatchId: dispatch.id },
      { store, task, dispatch, routeEvidence: [], routeIdentity: IDENTITY, nowMs: NOW }
    )
    expect(report.route.certification).toBe('UNTESTED')
    expect(report.route.failureReason).toBeTruthy()
    expect(report.nextLegalActions).toContain('recertify_route')
    expect(report.nextLegalActions).toContain('escalate_protected_blocker')
  })

  it('reports an unadmitted legacy Run as legacyUnbound and asks for admission first', () => {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'historical' })
    const report = describeOutcomeState({ runId: task.run_id, taskId: task.id }, { store, task, nowMs: NOW })
    expect(report.identity.legacyUnbound).toBe(true)
    expect(report.nextLegalActions).toEqual(['admit_outcome'])
  })

  it('reports an unverifiable liveness verdict when no marker has been written', () => {
    const { store, task, dispatch } = setup()
    const report = describeOutcomeState(
      { runId: task.run_id, taskId: task.id, dispatchId: dispatch.id },
      { store, task, dispatch, routeEvidence: passingEvidence(), routeIdentity: IDENTITY, nowMs: NOW }
    )
    expect(report.liveness.verdict).toBe('unverifiable')
  })

  it('stays bounded: one event, one liveness verdict, no worker list and no transcript', () => {
    const { store, task, dispatch } = setup()
    const many = Array.from({ length: 50 }, (_unused, index) =>
      message({ id: `msg_${index}`, type: index % 2 === 0 ? 'status' : 'escalation', sequence: index })
    )
    const report = describeOutcomeState(
      { runId: task.run_id, taskId: task.id, dispatchId: dispatch.id },
      {
        store,
        task,
        dispatch,
        recentMessages: many,
        routeEvidence: passingEvidence(),
        routeIdentity: IDENTITY,
        nowMs: NOW
      }
    )
    expect(report.lastMeaningfulEvent?.messageId).toBe('msg_49')
    expect(Object.keys(report).sort()).toEqual([
      'completionGate',
      'identity',
      'lastMeaningfulEvent',
      'lifecycle',
      'liveness',
      'nextLegalActions',
      'route'
    ])
  })
})
