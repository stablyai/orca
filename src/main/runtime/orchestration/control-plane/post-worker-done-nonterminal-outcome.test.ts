import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { reconcileLifecycleMessage } from '../lifecycle-reconciliation'
import { ControlPlaneStore } from './control-plane-store'
import { classifyWakeReason } from './coordinator-wake-events'
import { admitOutcome } from './outcome-identity'
import { OutcomePolicyStore } from './outcome-policy'
import { PhaseLaunchStore } from './phase-launch-store'
import type { RouteIdentity } from './route-registry-types'

const HEAD = 'a1b2c3d4e5f6'
const BUILDER: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
const REVIEWER: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'xhigh' }

/** POST_WORKER_DONE_NONTERMINAL_OUTCOME_STALL — observed on candidate runtime
 *  `b9ae9c67-aaa3-4ec8-a4a7-c54adb1bf999`, Run `run_a1a4bea2bb69`,
 *  Task `task_2879dbc09fdd`, Dispatch `ctx_41271b23abb5`.
 *
 *  A `worker_done` that settles its own Dispatch but leaves the OUTCOME
 *  unfinished is nonterminal for the outcome. The lifecycle must then do
 *  exactly one of two things: plan the next phase, or publish one explicit
 *  typed blocker. Silently settling and idling is the failure this pins —
 *  it looks like success to the coordinator while the outcome never advances.
 *
 *  On the candidate the reviewer route was registered and identity-proven but
 *  not yet certified, so the observed behaviour was the blocker branch:
 *  `Protected blocker: no_certified_reviewer_route`.
 */
describe('POST_WORKER_DONE_NONTERMINAL_OUTCOME_STALL', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function world(reviewerCandidates: RouteIdentity[]) {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'build it' })
    admitOutcome(store, {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Ship',
      fingerprint: 'f1'
    })
    new OutcomePolicyStore(db).put({
      outcomeId: 'out_1',
      taskClassification: 'bounded_implementation',
      builderCandidates: [BUILDER],
      reviewerCandidates,
      reviewCapabilities: [],
      allowUnknownQuota: false
    })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: BUILDER.agent,
        launch: {
          requested: { agent: BUILDER.agent, model: BUILDER.model, effort: BUILDER.reasoning },
          effective: { agent: BUILDER.agent, model: BUILDER.model, effort: BUILDER.reasoning }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_builder',
      paneKey: 'term_builder:leaf',
      processIncarnation: 'pty:term_builder',
      launchTokenHash: 'hash',
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return { task, dispatch: db.getDispatchContextById(started.dispatch.id)!, runId: task.run_id }
  }

  function report(taskId: string, dispatchId: string) {
    return db.insertMessage({
      from: 'term_builder',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      senderPaneKey: 'term_builder:leaf',
      payload: JSON.stringify({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        filesModified: ['a.txt'],
        completion: {
          taskId,
          dispatchId,
          outcomeId: 'out_1',
          headSha: HEAD,
          claimedSha: HEAD,
          worktreeClean: true,
          placement: 'local',
          receipt: {
            sha: HEAD,
            result: 'PASS',
            policyVersion: 'cand-v1',
            commandIdentity: 'synthetic-gate'
          }
        }
      })
    })
  }

  it('never settles a nonterminal outcome silently: it blocks explicitly when no reviewer is certified', () => {
    const { task, dispatch, runId } = world([REVIEWER])
    expect(reconcileLifecycleMessage(db, report(task.id, dispatch.id))).toMatchObject({
      action: 'completed'
    })

    // The Dispatch is terminal, but the OUTCOME is not: no phase was planned.
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(new PhaseLaunchStore(db).list(runId)).toEqual([])

    // So exactly one explicit typed blocker must exist. This is the assertion
    // that fails if the lifecycle ever regresses to settling and idling.
    const blockers = db
      .getRunMailboxHistory(runId, 50, ['escalation'])
      .filter((message) => message.subject.startsWith('Protected blocker'))
    expect(blockers).toHaveLength(1)
    const payload = JSON.parse(blockers[0].payload as string)
    expect(payload).toMatchObject({
      protectedBlocker: true,
      code: 'no_certified_reviewer_route',
      dispatchId: dispatch.id,
      taskId: task.id
    })
    // It must reach a parked coordinator, so it has to be in the wake set.
    expect(classifyWakeReason(blockers[0])).toBe('escalation')
  })

  it('negative control: with no reviewer candidate declared it still blocks rather than idling', () => {
    const { task, dispatch, runId } = world([])
    reconcileLifecycleMessage(db, report(task.id, dispatch.id))
    const blockers = db
      .getRunMailboxHistory(runId, 50, ['escalation'])
      .filter((message) => message.subject.startsWith('Protected blocker'))
    expect(blockers).toHaveLength(1)
    expect(new PhaseLaunchStore(db).list(runId)).toEqual([])
  })

  it('emits exactly one blocker per completion, not one per reconcile replay', () => {
    const { task, dispatch, runId } = world([REVIEWER])
    reconcileLifecycleMessage(db, report(task.id, dispatch.id))
    reconcileLifecycleMessage(db, report(task.id, dispatch.id))
    const blockers = db
      .getRunMailboxHistory(runId, 50, ['escalation'])
      .filter((message) => message.subject.startsWith('Protected blocker'))
    // A replayed completion is rejected before the advance runs, so the
    // coordinator is never woken twice for the same stall.
    expect(blockers).toHaveLength(1)
  })
})
