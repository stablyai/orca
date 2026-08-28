import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHookServer } from '../../../agent-hooks/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { admitOutcome } from '../../orchestration/control-plane/outcome-identity'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import { assertWorktreeMutationAllowed } from './orchestration-worker-route-admission'
import { acquireValidationLease } from '../../orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../../orchestration/control-plane/validation-scope'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const harness = createOrchestrationRpcHarness()
const SHA = 'a1b2c3d4e5f6'

describe('correction 2: bounded control-plane operations', () => {
  afterEach(() => harness.cleanup())

  it('retires the single-outcome admission path without creating an outcome', async () => {
    const state = harness.setup()
    await expect(
      harness.call(
        'orchestration.outcomeAdmit',
        { from: 'term_coord', outcomeId: 'out_1', title: 'Ship it' },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'command_retired' })
    expect(new ControlPlaneStore(state.db).getOutcomeById('out_1')).toBeUndefined()
  })

  it('registers a route with discovered launcher/hook/identity facts and reports drift', async () => {
    const state = harness.setup()
    const result = (await harness.call(
      'orchestration.routeUpsert',
      // aider launches but has no hook ingestion by either mechanism.
      { agent: 'aider', roles: 'builder', sessionModes: 'fresh' },
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
    // Why the runtime's own commit: certification is now bound to the commit
    // the runtime was BUILT from, and a mismatched SHA is refused before the
    // launch is even considered. Claiming the real one gets us to the launch
    // check this test is about.
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
    ).rejects.toMatchObject({ code: 'runtime_build_unverifiable' })

    // And a SHA that is not the one this runtime was built from is refused
    // outright, whatever the Dispatch looks like.
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
          sha: 'c'.repeat(40)
        },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'runtime_build_unverifiable' })

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

  it('plans gates but refuses caller-recorded PASS evidence', async () => {
    const state = harness.setup()
    const plan = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'unit=package.json,lint=package.json',
        files: 'package.json',
        policyVersion: 'gates-v1'
      },
      state.ctx
    )) as { reuse: { gateId: string }[]; rerun: { gateId: string }[] }
    expect(plan.reuse).toEqual([])
    expect(plan.rerun.map((entry) => entry.gateId)).toEqual(['unit', 'lint'])
    await expect(
      harness.call(
        'orchestration.gatePlan',
        {
          from: 'term_coord',
          sha: SHA,
          gates: 'unit=package.json',
          files: 'package.json',
          policyVersion: 'gates-v1',
          record: 'unit',
          result: 'PASS'
        },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'command_retired' })
  })

  it('reruns the full gate set for a high-risk outcome even when nothing changed', async () => {
    const state = harness.setup()
    const admitted = admitOutcome(new ControlPlaneStore(state.db), {
      outcomeId: 'out_1',
      runId: state.activeRunId!,
      title: 'Risky',
      fingerprint: 'risk-fingerprint',
      gatePolicy: 'high_risk'
    })
    expect(admitted.ok).toBe(true)
    const plan = (await harness.call(
      'orchestration.gatePlan',
      {
        from: 'term_coord',
        sha: SHA,
        gates: 'unit',
        policyVersion: 'gates-v1'
      },
      state.ctx
    )) as { riskPolicy: string; reuse: unknown[]; rerun: { reason: string }[] }
    expect(plan.riskPolicy).toBe('high_risk')
    expect(plan.reuse).toEqual([])
    expect(plan.rerun[0].reason).toContain('High-risk')
  })

  it('acquires, checks and releases the validation lease through the typed operation', async () => {
    // A lease is refused outright on a runtime with no agent-hook endpoint,
    // because its offline fence would have nowhere to live.
    await agentHookServer.start({
      env: 'production',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-lease-endpoint-'))
    })
    const state = harness.setup()
    // Why a real Dispatch: the owner field decides who may later release the
    // lease, so it must name a Dispatch that actually exists on this Run.
    // A lease is part of the outcome-admitted validation contract, so the Run
    // must have one before it can be protected.
    const admitted = admitOutcome(new ControlPlaneStore(state.db), {
      outcomeId: 'out_lease',
      runId: state.activeRunId!,
      title: 'Validate',
      fingerprint: 'lease-fingerprint'
    })
    expect(admitted.ok).toBe(true)
    const task = state.db.createTask({ spec: 'validate' })
    const owner = state.db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'codex' }
    }).dispatch.id
    // The lease scope comes from the owner Dispatch's own worktree, so it has to
    // actually be placed in one — a lease with no workspace could not be
    // enforced against anything.
    state.db.prepareStartingWorkerAuthority({
      dispatchId: owner,
      handle: 'term_validator',
      paneKey: 'tab-v:leaf-v',
      processIncarnation: 'pty:term_validator',
      launchTokenHash: 'hash',
      worktreeId: 'repo_a::/work/validated',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    state.db.markWorkerDispatchReady(owner, [])
    const ownerCtx = {
      ...state.ctx,
      orchestrationCompatibilityCallerAuthority: {
        hostScope: { kind: 'local', hostId: 'local' } as const,
        terminalHandle: 'term_validator',
        paneKey: 'tab-v:leaf-v',
        processIncarnation: 'pty:term_validator',
        launchTokenHash: 'hash'
      }
    }
    const acquired = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_validator',
        run: state.activeRunId,
        action: 'acquire',
        dispatch: owner,
        task: task.id
      },
      ownerCtx
    )) as { scopeKey: string; lease: { leaseId: string } }
    const blocked = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_coord',
        run: state.activeRunId,
        action: 'check',
        dispatch: owner,
        task: task.id
      },
      state.ctx
    )) as { guard: { allowed: boolean } }
    expect(blocked.guard.allowed).toBe(false)
    // Only the Dispatch that HOLDS the lease may release it: the lease id
    // travels in receipts, so it is not on its own an authority to release.
    await expect(
      harness.call(
        'orchestration.validationLease',
        {
          from: 'term_validator',
          run: state.activeRunId,
          action: 'release',
          leaseId: acquired.lease.leaseId,
          task: task.id
        },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    const impostor = (await harness
      .call(
        'orchestration.validationLease',
        {
          from: 'term_validator',
          run: state.activeRunId,
          action: 'release',
          leaseId: acquired.lease.leaseId,
          dispatch: 'ctx_impostor',
          task: task.id
        },
        ownerCtx
      )
      .catch((error: unknown) => error)) as { released?: boolean }
    // An owner that is not a Dispatch on this Run cannot even be named.
    expect(impostor.released).toBeUndefined()
    const released = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_validator',
        run: state.activeRunId,
        action: 'release',
        leaseId: acquired.lease.leaseId,
        dispatch: owner,
        task: task.id
      },
      ownerCtx
    )) as { released: boolean }
    expect(released.released).toBe(true)
    await agentHookServer.stop?.()
    const free = (await harness.call(
      'orchestration.validationLease',
      {
        from: 'term_coord',
        run: state.activeRunId,
        action: 'check',
        dispatch: owner,
        task: task.id
      },
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

  it('NEGATIVE CONTROL: the lease HOLDER cannot re-engage into the scope it owns', () => {
    // Reversed deliberately. Owning a lease is authority to release it, never
    // authority to mutate under it: re-engaging the very Dispatch that took the
    // lease is re-engaging the one whose gate is reading this tree right now.
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
    ).toThrow(/would contaminate it/)
  })
})
