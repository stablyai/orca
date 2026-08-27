import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import { ControlPlaneStore } from './control-plane-store'
import { canReuseGateReceipt, findGateReceipt, recordGateReceipt } from './gate-receipt-validity'
import {
  DEFAULT_VALIDATION_LEASE_TTL_MS,
  acquireValidationLease,
  assertMutationAllowed
} from './validation-lease'
import {
  resolveValidationScopeKey,
  validationScopeKeyForRun,
  validationScopeKeyForWorktree
} from './validation-scope'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')

describe('B9 correction 2: the lease scope is the worktree being mutated', () => {
  it('prefers the worktree the terminal actually lives in', async () => {
    await expect(
      resolveValidationScopeKey({
        runtime: { showTerminal: async () => ({ worktreeId: 'wt_42' }) },
        terminalHandle: 'term_worker',
        runId: 'run_1'
      })
    ).resolves.toBe(validationScopeKeyForWorktree('wt_42'))
  })

  it('falls back to the Run when no terminal or no worktree can be resolved', async () => {
    await expect(
      resolveValidationScopeKey({
        runtime: {
          showTerminal: async () => {
            throw new Error('gone')
          }
        },
        terminalHandle: 'term_gone',
        runId: 'run_1'
      })
    ).resolves.toBe(validationScopeKeyForRun('run_1'))
    await expect(
      resolveValidationScopeKey({
        runtime: { showTerminal: async () => ({ worktreeId: '' }) },
        runId: 'run_1'
      })
    ).resolves.toBe(validationScopeKeyForRun('run_1'))
  })
})

describe('B9 correction 2: a live suite fences worktree mutation', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    return { store, dispatch, scopeKey: validationScopeKeyForWorktree('wt_1') }
  }

  it('blocks a second worker while the suite holds the worktree, naming both remedies', () => {
    const { store, dispatch, scopeKey } = setup()
    acquireValidationLease(store, {
      scopeKey,
      leaseId: 'lease_1',
      owner: dispatch.id,
      idempotencyKey: 'idem',
      nowMs: NOW
    })
    const guard = assertMutationAllowed(store, { scopeKey, nowMs: NOW + 1_000 })
    expect(guard.allowed).toBe(false)
    expect(guard.allowed === false && guard.remedies).toEqual([
      'wait_for_lease_completion',
      'use_separate_worktree'
    ])
  })

  it('negative control: a different worktree stays writable, so the separate-worktree remedy is real', () => {
    const { store, dispatch, scopeKey } = setup()
    acquireValidationLease(store, {
      scopeKey,
      leaseId: 'lease_1',
      owner: dispatch.id,
      idempotencyKey: 'idem',
      nowMs: NOW
    })
    expect(
      assertMutationAllowed(store, {
        scopeKey: validationScopeKeyForWorktree('wt_other'),
        nowMs: NOW
      })
    ).toEqual({ allowed: true })
  })

  it('finds the lease by owner so a completing Dispatch can release a worktree-scoped lease', () => {
    const { store, dispatch, scopeKey } = setup()
    acquireValidationLease(store, {
      scopeKey,
      leaseId: 'lease_1',
      owner: dispatch.id,
      idempotencyKey: 'idem',
      nowMs: NOW
    })
    // The lookup is now expiry-aware, so it needs the clock the lease was taken on.
    const nowIso = new Date(NOW + 1000).toISOString()
    expect(store.findValidationLeaseByOwner(dispatch.id, nowIso)).toMatchObject({
      scope_key: scopeKey
    })
    expect(store.findValidationLeaseByOwner('ctx_other', nowIso)).toBeUndefined()
    // An expired lease is not a live credential, whoever owns it.
    const afterExpiry = new Date(NOW + DEFAULT_VALIDATION_LEASE_TTL_MS + 1000).toISOString()
    expect(store.findValidationLeaseByOwner(dispatch.id, afterExpiry)).toBeUndefined()
  })
})

describe('B8 correction 2: a FIX_FIRST commit invalidates the previous receipt', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('cannot reuse a receipt bound to the pre-correction SHA', () => {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const inputs = {
      gateId: 'pnpm test',
      finalSha: 'aaaaaaa',
      inputHashes: { 'src/a.ts': 'h1' },
      policyVersion: 'gates-v1',
      commandIdentity: 'pnpm test'
    }
    recordGateReceipt(store, {
      scopeKey: 'run_1:out_1',
      inputs,
      result: 'PASS',
      recordedAt: new Date(NOW).toISOString()
    })
    const receipt = findGateReceipt(store, 'run_1:out_1', 'pnpm test')
    expect(canReuseGateReceipt({ receipt, current: inputs })).toMatchObject({ reuse: true })
    // The correction round produces a new commit. What that invalidates is the
    // gate whose DEPENDENCIES moved with it, not every gate in the set: a
    // content gate whose inputs are byte-identical is still proven.
    expect(
      canReuseGateReceipt({ receipt, current: { ...inputs, finalSha: 'bbbbbbb' } })
    ).toMatchObject({ reuse: true })
    // The publication/review gates are the ones that die with the commit.
    expect(
      canReuseGateReceipt({
        receipt,
        current: { ...inputs, finalSha: 'bbbbbbb', shaBinding: 'exact_head' }
      })
    ).toMatchObject({ reuse: false, code: 'sha_changed' })
    // A correction that also touched a new file invalidates on inputs too.
    expect(
      canReuseGateReceipt({
        receipt,
        current: { ...inputs, inputHashes: { 'src/a.ts': 'h1', 'src/b.ts': 'h2' } }
      })
    ).toMatchObject({ reuse: false, code: 'inputs_changed' })
  })
})
