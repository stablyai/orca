import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import { reconcileLifecycleMessage } from '../lifecycle-reconciliation'
import { ControlPlaneStore } from './control-plane-store'
import { classifyWakeReason } from './coordinator-wake-events'
import { findGateReceipt } from './gate-receipt-validity'
import { ModelPerformanceLedger } from './model-performance-ledger'
import { admitOutcome } from './outcome-identity'
import { OutcomePolicyStore } from './outcome-policy'
import { requiredEvidenceKinds, type RouteEvidence } from './route-certification-evidence'
import { RouteRegistryStore } from './route-registry-store'
import { routeKey, UNKNOWN, type RouteIdentity, type RouteRow } from './route-registry-types'
import { acquireValidationLease } from './validation-lease'
import { advanceAfterValidatedCompletion } from './lifecycle-advance'

const HEAD = 'a1b2c3d4e5f6'
const BUILDER: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }
const REVIEWER: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }

function routeRow(identity: RouteIdentity, roles: ('builder' | 'reviewer')[]): RouteRow {
  return {
    identity,
    provider: 'p',
    harness: 'h',
    roles,
    taskCapabilities: ['bounded_implementation', 'adversarial_review'],
    sessionModes: ['fresh', 'retained'],
    reasoningModes: ['high'],
    contextLimitTokens: UNKNOWN,
    costClass: UNKNOWN,
    identityProof: 'exact',
    launcherSupported: true,
    hookSupported: true,
    readiness: {
      availability: 'available',
      authenticated: true,
      providerStatus: 'ok',
      quota: { state: 'ok', resetAt: UNKNOWN, remainingFraction: UNKNOWN }
    },
    constraints: [],
    notes: null
  }
}

function evidenceFor(
  identity: RouteIdentity,
  role: 'builder' | 'reviewer',
  sessionMode: 'fresh' | 'retained'
): RouteEvidence[] {
  return requiredEvidenceKinds(sessionMode).map((kind) => ({
    routeKey: routeKey(identity),
    kind,
    role,
    sessionMode,
    outcome: 'PASS' as const,
    observedAt: new Date().toISOString(),
    runtimeVersion: '1.4.188',
    commitSha: HEAD,
    detail: null
  }))
}

describe('correction 2: automatic builder to reviewer lifecycle', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function world(options: { reviewerCandidates?: RouteIdentity[] } = {}) {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const registry = new RouteRegistryStore(db)
    registry.upsertRoute(routeRow(BUILDER, ['builder']))
    registry.upsertRoute(routeRow(REVIEWER, ['reviewer']))
    for (const record of [
      ...evidenceFor(BUILDER, 'builder', 'retained'),
      ...evidenceFor(REVIEWER, 'reviewer', 'fresh')
    ]) {
      registry.recordRouteEvidence(record)
    }
    const task = db.createTask({ spec: 'build the thing' })
    admitOutcome(store, {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Build the thing',
      fingerprint: 'f1'
    })
    new OutcomePolicyStore(db).put({
      outcomeId: 'out_1',
      taskClassification: 'bounded_implementation',
      builderCandidates: [BUILDER],
      reviewerCandidates: options.reviewerCandidates ?? [REVIEWER],
      reviewCapabilities: [],
      allowUnknownQuota: false
    })
    return { store, task, runId: task.run_id }
  }

  function launchWorker(taskId: string, identity: RouteIdentity, handle: string) {
    const started = db.createStartingWorkerDispatch({
      taskId,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: identity.agent,
        launch: {
          requested: { agent: identity.agent, model: identity.model, effort: identity.reasoning },
          effective: { agent: identity.agent, model: identity.model, effort: identity.reasoning }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: `${handle}:leaf`,
      processIncarnation: `pty:${handle}`,
      launchTokenHash: `hash_${handle}`,
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    // Readiness is what moves the Dispatch to `dispatched`; a pending row is
    // not yet a lifecycle authority.
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return db.getDispatchContextById(started.dispatch.id)!
  }

  function report(args: {
    taskId: string
    dispatchId: string
    paneKey: string
    handle: string
    corrections?: string[]
    files?: string[]
  }) {
    return db.insertMessage({
      from: args.handle,
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      senderPaneKey: args.paneKey,
      payload: JSON.stringify({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        outcome: 'succeeded',
        filesModified: args.files ?? ['src/a.ts'],
        ...(args.corrections ? { corrections: args.corrections } : {}),
        completion: {
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          outcomeId: 'out_1',
          headSha: HEAD,
          claimedSha: HEAD,
          worktreeClean: true,
          placement: 'local',
          receipt: {
            sha: HEAD,
            result: 'PASS',
            policyVersion: 'gates-v1',
            commandIdentity: 'pnpm test'
          }
        }
      })
    })
  }

  it('creates an independent reviewer phase bound to the exact SHA after a validated build', () => {
    const { task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    const notify = vi.fn()
    expect(
      reconcileLifecycleMessage(
        db,
        report({
          taskId: task.id,
          dispatchId: builder.id,
          paneKey: 'term_builder:leaf',
          handle: 'term_builder'
        }),
        undefined,
        { notify }
      )
    ).toMatchObject({ action: 'completed' })

    const phases = new OutcomePolicyStore(db).listPhases('out_1')
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({
      kind: 'review',
      bound_sha: HEAD,
      source_dispatch_id: builder.id
    })
    const reviewTask = db.getTask(phases[0].task_id)
    expect(reviewTask?.spec).toContain(HEAD)
    expect(reviewTask?.spec).toContain('do not review the branch tip')
  })

  it('records the completion receipt as a reusable gate receipt', () => {
    const { store, task, runId } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    const receipt = findGateReceipt(store, `${runId}:out_1`, 'pnpm test')
    expect(receipt).toMatchObject({ finalSha: HEAD, result: 'PASS', policyVersion: 'gates-v1' })
    expect(Object.keys(receipt?.inputHashes ?? {})).toEqual(['src/a.ts'])
  })

  it('releases the validation lease the completing Dispatch held', () => {
    const { store, task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    acquireValidationLease(store, {
      scopeKey: 'wt:wt_1',
      leaseId: 'lease_1',
      owner: builder.id,
      idempotencyKey: 'idem',
      nowMs: Date.now()
    })
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    expect(store.getValidationLease('wt:wt_1')?.released_at).toBeTruthy()
  })

  it('writes one evidence-backed ledger entry with the observed route and no invented usage', () => {
    const { task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    const entries = new ModelPerformanceLedger(db).list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      route_key: routeKey(BUILDER),
      role: 'builder',
      first_pass_result: 'accepted',
      provenance: 'observed_runtime',
      tool_calls: null,
      context_tokens_used: null
    })
  })

  it('emits a protected blocker instead of choosing a reviewer when none is certified', () => {
    const { task, runId } = world({ reviewerCandidates: [] })
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    expect(new OutcomePolicyStore(db).listPhases('out_1')).toEqual([])
    const escalation = db
      .getRunMailboxHistory(runId, 20, ['escalation'])
      .find((message) => message.subject.startsWith('Protected blocker'))
    expect(escalation).toBeTruthy()
    expect(JSON.parse(escalation!.payload as string).protectedBlocker).toBe(true)
    expect(classifyWakeReason(escalation!)).toBe('escalation')
  })

  it('is idempotent: a replayed completion never forks a second reviewer phase', () => {
    const { task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    const first = report({
      taskId: task.id,
      dispatchId: builder.id,
      paneKey: 'term_builder:leaf',
      handle: 'term_builder'
    })
    reconcileLifecycleMessage(db, first)
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    expect(new OutcomePolicyStore(db).listPhases('out_1')).toHaveLength(1)
  })

  it('routes one consolidated FIX_FIRST round back to the same retained builder', () => {
    const { task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    const policyStore = new OutcomePolicyStore(db)
    const reviewPhase = policyStore.listPhases('out_1')[0]
    const reviewer = launchWorker(reviewPhase.task_id, REVIEWER, 'term_reviewer')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: reviewPhase.task_id,
        dispatchId: reviewer.id,
        paneKey: 'term_reviewer:leaf',
        handle: 'term_reviewer',
        corrections: ['fix the null check', 'add the missing test']
      })
    )
    const phases = policyStore.listPhases('out_1')
    const fix = phases.find((phase) => phase.kind === 'fix_first')
    expect(fix).toBeTruthy()
    // The correction targets the BUILD dispatch, never the reviewer that raised it.
    expect(fix?.source_dispatch_id).toBe(reviewer.id)
    const fixTask = db.getTask(fix!.task_id)
    expect(fixTask?.spec).toContain('ONE consolidated correction round')
    expect(fixTask?.spec).toContain('fix the null check')
    expect(fixTask?.spec).toContain('add the missing test')
    expect(fixTask?.spec).toContain('Rerun every gate the new commit invalidates')
  })

  it('FIX_FIRST names the original builder terminal, never the reviewer that raised it', () => {
    const { task } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    const reviewPhase = new OutcomePolicyStore(db).listPhases('out_1')[0]
    const reviewer = launchWorker(reviewPhase.task_id, REVIEWER, 'term_reviewer')
    const advanced = advanceAfterValidatedCompletion({
      db,
      dispatch: db.getDispatchContextById(reviewer.id)!,
      taskId: reviewPhase.task_id,
      claim: {
        taskId: reviewPhase.task_id,
        dispatchId: reviewer.id,
        runId: task.run_id,
        outcomeId: 'out_1',
        headSha: HEAD,
        claimedSha: HEAD,
        worktreeClean: true,
        placement: 'local',
        receipt: null
      },
      corrections: ['tighten the guard'],
      filesModified: [],
      outcomeOfReport: 'succeeded',
      nowMs: Date.now()
    })
    expect(advanced.kind).toBe('advanced')
    const plan = advanced.kind === 'advanced' ? advanced.plan : null
    expect(plan).toMatchObject({
      kind: 'fix_first',
      builderDispatchId: builder.id,
      terminalHandle: 'term_builder',
      boundSha: HEAD
    })
    expect(plan && 'route' in plan && routeKey(plan.route.identity)).toBe(routeKey(BUILDER))
  })

  it('ends the chain with a REVIEW_COMPLETE wake when the reviewer reports no corrections', () => {
    const { task, runId } = world()
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: task.id,
        dispatchId: builder.id,
        paneKey: 'term_builder:leaf',
        handle: 'term_builder'
      })
    )
    const reviewPhase = new OutcomePolicyStore(db).listPhases('out_1')[0]
    const reviewer = launchWorker(reviewPhase.task_id, REVIEWER, 'term_reviewer')
    reconcileLifecycleMessage(
      db,
      report({
        taskId: reviewPhase.task_id,
        dispatchId: reviewer.id,
        paneKey: 'term_reviewer:leaf',
        handle: 'term_reviewer'
      })
    )
    const wake = db
      .getRunMailboxHistory(runId, 20, ['escalation'])
      .find((message) => message.subject.startsWith('Review complete'))
    expect(wake).toBeTruthy()
    expect(classifyWakeReason(wake!)).toBe('review_complete')
    expect(new OutcomePolicyStore(db).listPhases('out_1')).toHaveLength(1)
  })

  it('negative control: a legacy Run with no admitted outcome plans nothing', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'legacy work' })
    const builder = launchWorker(task.id, BUILDER, 'term_builder')
    expect(
      reconcileLifecycleMessage(
        db,
        db.insertMessage({
          from: 'term_builder',
          to: 'term_coordinator',
          subject: 'Done',
          type: 'worker_done',
          senderPaneKey: 'term_builder:leaf',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: builder.id,
            outcome: 'succeeded'
          })
        })
      )
    ).toMatchObject({ action: 'completed' })
    expect(new ModelPerformanceLedger(db).list()).toEqual([])
  })
})
