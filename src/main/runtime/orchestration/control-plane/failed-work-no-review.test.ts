import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { resolveAdvanceEligibility } from './advance-eligibility'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'
import { OutcomePolicyStore } from './outcome-policy'
import { PhaseLaunchStore } from './phase-launch-store'
import { advanceAfterValidatedCompletion } from './lifecycle-advance'
import type { RouteIdentity } from './route-registry-types'

/** FAILED_WORK_NO_REVIEW — the advance planned the next phase from the mere
 *  fact that a completion arrived. A builder that reported `--outcome failed`,
 *  or whose completion gate came back FAIL, still earned a reviewer.
 */
describe('FAILED_WORK_NO_REVIEW', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const BUILDER: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const REVIEWER: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'xhigh' }
  const HEAD = 'a1b2c3d4e5f6'
  const NOW = Date.parse('2026-08-27T18:00:00Z')

  function world() {
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
      reviewerCandidates: [REVIEWER],
      reviewCapabilities: [],
      allowUnknownQuota: true
    })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'codex',
        launch: {
          requested: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
          effective: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_builder',
      paneKey: 'pane:leaf',
      processIncarnation: 'pty:term_builder',
      launchTokenHash: 'hash',
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    db.db
      .prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`)
      .run(started.dispatch.id)
    return {
      runId: task.run_id,
      taskId: task.id,
      dispatch: db.getDispatchContextById(started.dispatch.id)!
    }
  }

  function advance(outcomeOfReport: 'succeeded' | 'failed', result: 'PASS' | 'FAIL') {
    const { taskId, dispatch } = world()
    return advanceAfterValidatedCompletion({
      db: db!,
      dispatch,
      taskId,
      claim: {
        taskId,
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        outcomeId: 'out_1',
        headSha: HEAD,
        claimedSha: HEAD,
        worktreeClean: true,
        placement: 'local',
        receipt: {
          sha: HEAD,
          result,
          policyVersion: 'v1',
          commandIdentity: 'gate-x'
        }
      },
      corrections: [],
      filesModified: ['a.txt'],
      outcomeOfReport,
      nowMs: NOW
    })
  }

  it('creates zero review Task, Dispatch or session for a builder that reported failure', () => {
    const result = advance('failed', 'PASS')
    expect(result).toMatchObject({ kind: 'not_advanced', code: 'outcome_failed' })
    expect(new PhaseLaunchStore(db!).list(db!.getTask('x')?.run_id ?? '')).toEqual([])
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcome_phases').get()).toEqual({
      n: 0
    })
    // Exactly one Task and one Dispatch: nothing new was created for a review.
    expect(db!.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    expect(db!.db.prepare('SELECT count(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 1 })
  })

  it('creates zero review work when the completion gate came back FAIL', () => {
    const result = advance('succeeded', 'FAIL')
    expect(result).toMatchObject({ kind: 'not_advanced', code: 'completion_gate_failed' })
    expect(db!.db.prepare('SELECT count(*) AS n FROM control_plane_outcome_phases').get()).toEqual({
      n: 0
    })
    expect(db!.db.prepare('SELECT count(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 1 })
  })

  it('escalates once, with a typed code, instead of settling silently', () => {
    const { taskId, dispatch } = world()
    const runId = dispatch.run_id
    for (let attempt = 0; attempt < 2; attempt++) {
      advanceAfterValidatedCompletion({
        db: db!,
        dispatch,
        taskId,
        claim: {
          taskId,
          dispatchId: dispatch.id,
          runId: dispatch.run_id,
          outcomeId: 'out_1',
          headSha: HEAD,
          claimedSha: HEAD,
          worktreeClean: true,
          placement: 'local',
          receipt: { sha: HEAD, result: 'FAIL', policyVersion: 'v1', commandIdentity: 'gate-x' }
        },
        corrections: [],
        filesModified: [],
        outcomeOfReport: 'succeeded',
        nowMs: NOW + attempt
      })
    }
    const blockers = db!
      .getRunMailboxHistory(runId, 50, ['escalation'])
      .filter((message) => message.subject.startsWith('Protected blocker'))
    expect(blockers).toHaveLength(1)
    expect(JSON.parse(blockers[0].payload as string)).toMatchObject({
      protectedBlocker: true,
      code: 'completion_gate_failed'
    })
  })

  it('names every typed non-success state that must not advance', () => {
    const base = { dispatch: { id: 'ctx_1', status: 'completed' as const }, receiptRequired: true }
    expect(
      resolveAdvanceEligibility({ ...base, outcomeOfReport: 'succeeded', gateResult: 'PASS' })
    ).toEqual({ eligible: true })
    expect(
      resolveAdvanceEligibility({ ...base, outcomeOfReport: 'failed', gateResult: 'PASS' })
    ).toMatchObject({ eligible: false, code: 'outcome_failed' })
    expect(
      resolveAdvanceEligibility({ ...base, outcomeOfReport: 'succeeded', gateResult: 'FAIL' })
    ).toMatchObject({ eligible: false, code: 'completion_gate_failed' })
    expect(
      resolveAdvanceEligibility({ ...base, outcomeOfReport: 'succeeded', gateResult: null })
    ).toMatchObject({ eligible: false, code: 'completion_receipt_missing' })
    for (const status of ['failed', 'pending', 'dispatched', 'circuit_broken'] as const) {
      expect(
        resolveAdvanceEligibility({
          dispatch: { id: 'ctx_1', status },
          outcomeOfReport: 'succeeded',
          gateResult: 'PASS',
          receiptRequired: true
        }),
        status
      ).toMatchObject({ eligible: false, code: 'completion_not_accepted' })
    }
  })
})

/** A bootstrap Dispatch exists only to produce evidence. If its completion could
 *  advance a real outcome, an uncertified route would be laundered into
 *  delivered work — the bootstrap would become the bypass. */
describe('A BOOTSTRAP DISPATCH CANNOT ADVANCE A REAL OUTCOME', () => {
  const dispatch = { id: 'ctx_boot', status: 'completed' as const }

  it('refuses the advance even when everything else is perfect', () => {
    expect(
      resolveAdvanceEligibility({
        dispatch,
        outcomeOfReport: 'succeeded',
        gateResult: 'PASS',
        receiptRequired: true,
        certificationBootstrap: true
      })
    ).toMatchObject({ eligible: false, code: 'certification_bootstrap_dispatch' })
  })

  it('negative control: the identical completion advances when it is ordinary work', () => {
    expect(
      resolveAdvanceEligibility({
        dispatch,
        outcomeOfReport: 'succeeded',
        gateResult: 'PASS',
        receiptRequired: true,
        certificationBootstrap: false
      })
    ).toEqual({ eligible: true })
  })
})
