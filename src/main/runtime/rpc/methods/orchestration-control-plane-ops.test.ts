import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import { assertWorktreeMutationAllowed } from './orchestration-worker-route-admission'
import { acquireValidationLease } from '../../orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../../orchestration/control-plane/validation-scope'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const harness = createOrchestrationRpcHarness()
const SHA = 'a1b2c3d4e5f6'

describe('correction 2: bounded control-plane operations', () => {
  afterEach(() => harness.cleanup())

  it('admits an outcome and stores the caller-declared candidate order verbatim', async () => {
    const state = harness.setup()
    const result = (await harness.call(
      'orchestration.outcomeAdmit',
      {
        from: 'term_coord',
        outcomeId: 'out_1',
        title: 'Ship it',
        builderCandidates: 'claude:opus-5:high',
        reviewerCandidates: 'codex:gpt-5.6-sol:high,grok:grok-4.6',
        reviewCapabilities: 'adversarial_review'
      },
      state.ctx
    )) as { outcome: { run_id: string }; duplicate: boolean }
    expect(result.outcome.run_id).toBe(state.activeRunId)
    const policy = new OutcomePolicyStore(state.db).get('out_1')
    // Order is preserved exactly; the control plane never reorders candidates.
    expect(policy.reviewerCandidates).toEqual([
      { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' },
      { agent: 'grok', model: 'grok-4.6', reasoning: null }
    ])
    expect(policy.builderCandidates).toEqual([
      { agent: 'claude', model: 'opus-5', reasoning: 'high' }
    ])
  })

  it('registers a route with discovered launcher/hook/identity facts and reports drift', async () => {
    const state = harness.setup()
    const result = (await harness.call(
      'orchestration.routeUpsert',
      { agent: 'opencode', roles: 'builder', sessionModes: 'fresh' },
      state.ctx
    )) as {
      route: { launcherSupported: boolean; hookSupported: boolean }
      drift: { code: string }[]
    }
    expect(result.route.launcherSupported).toBe(true)
    expect(result.route.hookSupported).toBe(false)
    expect(result.drift.map((fault) => fault.code)).toContain('launcher_supported_hook_rejected')
    expect(new RouteRegistryStore(state.db).listRoutes()).toHaveLength(1)
  })

  it('refuses PASS certification with no real launch and accepts FAIL without one', async () => {
    const state = harness.setup()
    await expect(
      harness.call(
        'orchestration.certify',
        {
          agent: 'claude',
          model: 'opus-5',
          role: 'builder',
          sessionMode: 'fresh',
          kind: 'fresh_launch',
          outcome: 'PASS',
          sha: SHA
        },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'unknown_dispatch' })

    const failed = (await harness.call(
      'orchestration.certify',
      {
        agent: 'claude',
        model: 'opus-5',
        role: 'builder',
        sessionMode: 'fresh',
        kind: 'fresh_launch',
        outcome: 'FAIL',
        sha: SHA,
        detail: 'CLI missing'
      },
      state.ctx
    )) as { evidence: { outcome: string; observedAt: string } }
    expect(failed.evidence.outcome).toBe('FAIL')
    expect(Date.parse(failed.evidence.observedAt)).not.toBeNaN()
  })

  it('returns the role matrix with the outstanding evidence kinds', async () => {
    const state = harness.setup()
    await harness.call(
      'orchestration.routeUpsert',
      { agent: 'grok', model: 'grok-4.6', roles: 'builder', sessionModes: 'fresh' },
      state.ctx
    )
    const result = (await harness.call('orchestration.routes', { sha: SHA }, state.ctx)) as {
      matrix: { routeKey: string; cells: { state: string }[] }[]
    }
    expect(result.matrix).toHaveLength(1)
    expect(result.matrix[0].routeKey).toBe('grok|grok-4.6|')
    expect(result.matrix[0].cells.every((cell) => cell.state === 'UNTESTED')).toBe(true)
  })

  it('plans gates, records one receipt, and reuses it only while the inputs hold', async () => {
    const state = harness.setup()
    await harness.call(
      'orchestration.outcomeAdmit',
      { from: 'term_coord', outcomeId: 'out_1', title: 'Ship it' },
      state.ctx
    )
    const first = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'unit,lint',
        files: 'src/a.ts',
        policyVersion: 'gates-v1',
        record: 'unit',
        result: 'PASS'
      },
      state.ctx
    )) as { reuse: { gateId: string }[]; rerun: { gateId: string }[] }
    expect(first.reuse.map((entry) => entry.gateId)).toEqual(['unit'])
    expect(first.rerun.map((entry) => entry.gateId)).toEqual(['lint'])

    // Moving the commit alone does not invalidate a content gate: it proves
    // something about its inputs, and those are byte-identical here.
    const moved = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: 'ffffff1',
        gates: 'unit',
        files: 'src/a.ts',
        policyVersion: 'gates-v1'
      },
      state.ctx
    )) as { reuse: { gateId: string }[]; rerun: { gateId: string; reason: string }[] }
    expect(moved.reuse.map((entry) => entry.gateId)).toEqual(['unit'])

    // Changing a gate CONFIGURATION input is a different gate, so it reruns.
    const rebadged = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'unit',
        files: 'src/a.ts',
        policyVersion: 'gates-v2'
      },
      state.ctx
    )) as { rerun: { gateId: string; reason: string }[] }
    expect(rebadged.rerun[0].gateId).toBe('unit')

    // A review gate is bound to its exact head and dies with the commit.
    const review = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'review-exact',
        files: 'src/a.ts',
        policyVersion: 'gates-v1',
        record: 'review-exact',
        result: 'PASS'
      },
      state.ctx
    )) as { reuse: { gateId: string }[] }
    expect(review.reuse.map((entry) => entry.gateId)).toEqual(['review-exact'])
    const reviewMoved = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: 'ffffff1',
        gates: 'review-exact',
        files: 'src/a.ts',
        policyVersion: 'gates-v1'
      },
      state.ctx
    )) as { rerun: { gateId: string; reason: string }[] }
    expect(reviewMoved.rerun[0].reason).toContain(SHA)
  })

  it('reruns the full gate set for a high-risk outcome even when nothing changed', async () => {
    const state = harness.setup()
    await harness.call(
      'orchestration.outcomeAdmit',
      { from: 'term_coord', outcomeId: 'out_1', title: 'Risky', gatePolicy: 'high_risk' },
      state.ctx
    )
    const plan = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'unit',
        policyVersion: 'gates-v1',
        record: 'unit',
        result: 'PASS'
      },
      state.ctx
    )) as { riskPolicy: string; reuse: unknown[]; rerun: { reason: string }[] }
    expect(plan.riskPolicy).toBe('high_risk')
    expect(plan.reuse).toEqual([])
    expect(plan.rerun[0].reason).toContain('High-risk')
  })

  it('acquires, checks and releases the validation lease through the typed operation', async () => {
    const state = harness.setup()
    const acquired = (await harness.call(
      'orchestration.validationLease',
      { from: 'term_coord', action: 'acquire', dispatch: 'ctx_1' },
      state.ctx
    )) as { scopeKey: string; lease: { leaseId: string } }
    const blocked = (await harness.call(
      'orchestration.validationLease',
      { from: 'term_coord', action: 'check' },
      state.ctx
    )) as { guard: { allowed: boolean } }
    expect(blocked.guard.allowed).toBe(false)
    // Only the Dispatch that HOLDS the lease may release it: the lease id
    // travels in receipts, so it is not on its own an authority to release.
    await expect(
      harness.call(
        'orchestration.validationLease',
        { from: 'term_coord', action: 'release', leaseId: acquired.lease.leaseId },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    const impostor = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_coord',
        action: 'release',
        leaseId: acquired.lease.leaseId,
        dispatch: 'ctx_impostor'
      },
      state.ctx
    )) as { released: boolean }
    expect(impostor.released).toBe(false)
    const released = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_coord',
        action: 'release',
        leaseId: acquired.lease.leaseId,
        dispatch: 'ctx_1'
      },
      state.ctx
    )) as { released: boolean }
    expect(released.released).toBe(true)
    const free = (await harness.call(
      'orchestration.validationLease',
      { from: 'term_coord', action: 'check' },
      state.ctx
    )) as { guard: { allowed: boolean } }
    expect(free.guard.allowed).toBe(true)
  })
})

describe('B9 correction 2: worker-start refuses a worktree under an active suite', () => {
  afterEach(() => harness.cleanup())

  it('throws validation_in_progress with the remedies attached', () => {
    const state = harness.setup()
    const store = new ControlPlaneStore(state.db)
    acquireValidationLease(store, {
      scopeKey: validationScopeKeyForWorktree('wt_1'),
      leaseId: 'lease_1',
      owner: 'ctx_suite',
      idempotencyKey: 'idem',
      nowMs: Date.now()
    })
    expect(() =>
      assertWorktreeMutationAllowed({ handle: state.db, worktreeId: 'wt_1' })
    ).toThrowError(/Validation lease .* is active/)
    // Negative control: an untouched worktree still dispatches.
    expect(() =>
      assertWorktreeMutationAllowed({ handle: state.db, worktreeId: 'wt_other' })
    ).not.toThrow()
  })

  it('lets the lease holder itself keep mutating the scope it owns', () => {
    const state = harness.setup()
    const store = new ControlPlaneStore(state.db)
    acquireValidationLease(store, {
      scopeKey: validationScopeKeyForWorktree('wt_1'),
      leaseId: 'lease_1',
      owner: 'ctx_suite',
      idempotencyKey: 'idem',
      nowMs: Date.now()
    })
    expect(() =>
      assertWorktreeMutationAllowed({
        handle: state.db,
        worktreeId: 'wt_1',
        dispatchId: 'ctx_suite'
      })
    ).not.toThrow()
  })
})
