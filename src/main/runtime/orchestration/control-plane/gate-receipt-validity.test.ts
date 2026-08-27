import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  canReuseGateReceipt,
  findGateReceipt,
  gateReceiptId,
  planGateSet,
  recordGateReceipt,
  type GateInputs
} from './gate-receipt-validity'

const SHA = 'abc1234'
const RECORDED_AT = '2026-08-27T11:00:00.000Z'

function inputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    gateId: 'unit-tests',
    finalSha: SHA,
    inputHashes: { 'src/a.ts': 'h1', 'src/b.ts': 'h2' },
    policyVersion: 'gates-v3',
    commandIdentity: 'pnpm test src',
    ...overrides
  }
}

describe('B8 gate receipts bind deterministic inputs', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  it('reuses a PASS receipt when every bound input is unchanged', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS', recordedAt: RECORDED_AT })
    expect(
      canReuseGateReceipt({ receipt: findGateReceipt(cp, 'wt_1', 'unit-tests'), current: inputs() })
    ).toMatchObject({ reuse: true })
  })

  it('invalidates the receipt when the final SHA moves', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS', recordedAt: RECORDED_AT })
    expect(
      canReuseGateReceipt({
        receipt: findGateReceipt(cp, 'wt_1', 'unit-tests'),
        current: inputs({ finalSha: 'feedface' })
      })
    ).toMatchObject({ reuse: false, code: 'sha_changed' })
  })

  it('invalidates the receipt when a bound input hash changes, and names the input', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS', recordedAt: RECORDED_AT })
    const verdict = canReuseGateReceipt({
      receipt: findGateReceipt(cp, 'wt_1', 'unit-tests'),
      current: inputs({ inputHashes: { 'src/a.ts': 'h1', 'src/b.ts': 'CHANGED' } })
    })
    expect(verdict).toMatchObject({ reuse: false, code: 'inputs_changed' })
    expect(verdict.reuse === false && verdict.reason).toContain('src/b.ts')
  })

  it('invalidates the receipt when the policy version or the command identity changes', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS', recordedAt: RECORDED_AT })
    const receipt = findGateReceipt(cp, 'wt_1', 'unit-tests')
    expect(
      canReuseGateReceipt({ receipt, current: inputs({ policyVersion: 'gates-v4' }) })
    ).toMatchObject({ reuse: false, code: 'policy_version_changed' })
    expect(
      canReuseGateReceipt({ receipt, current: inputs({ commandIdentity: 'pnpm test --all' }) })
    ).toMatchObject({ reuse: false, code: 'command_changed' })
  })

  it('never reuses a FAIL receipt or a missing one', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'FAIL', recordedAt: RECORDED_AT })
    expect(
      canReuseGateReceipt({ receipt: findGateReceipt(cp, 'wt_1', 'unit-tests'), current: inputs() })
    ).toMatchObject({ reuse: false, code: 'receipt_failed' })
    expect(canReuseGateReceipt({ receipt: undefined, current: inputs() })).toMatchObject({
      reuse: false,
      code: 'no_receipt'
    })
  })

  it('high-risk policy reruns the full gate set even when nothing changed', () => {
    const cp = store()
    recordGateReceipt(cp, { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS', recordedAt: RECORDED_AT })
    expect(
      canReuseGateReceipt({
        receipt: findGateReceipt(cp, 'wt_1', 'unit-tests'),
        current: inputs(),
        riskPolicy: 'high_risk'
      })
    ).toMatchObject({ reuse: false, code: 'high_risk_policy' })
  })

  it('re-recording the same gate result is idempotent, not a duplicate row', () => {
    const cp = store()
    const spec = { scopeKey: 'wt_1', inputs: inputs(), result: 'PASS' as const, recordedAt: RECORDED_AT }
    recordGateReceipt(cp, spec)
    recordGateReceipt(cp, spec)
    expect(cp.listGateReceipts('wt_1')).toHaveLength(1)
    expect(gateReceiptId(inputs())).toBe(gateReceiptId(inputs()))
  })

  it('plans an incremental gate set, reporting exactly which gates rerun and why', () => {
    const cp = store()
    recordGateReceipt(cp, {
      scopeKey: 'wt_1',
      inputs: inputs({ gateId: 'lint' }),
      result: 'PASS',
      recordedAt: RECORDED_AT
    })
    recordGateReceipt(cp, {
      scopeKey: 'wt_1',
      inputs: inputs({ gateId: 'unit-tests' }),
      result: 'PASS',
      recordedAt: RECORDED_AT
    })
    const plan = planGateSet({
      store: cp,
      scopeKey: 'wt_1',
      gates: [
        inputs({ gateId: 'lint' }),
        inputs({ gateId: 'unit-tests', inputHashes: { 'src/a.ts': 'MOVED', 'src/b.ts': 'h2' } }),
        inputs({ gateId: 'typecheck' })
      ]
    })
    expect(plan.reuse.map((entry) => entry.gateId)).toEqual(['lint'])
    expect(plan.rerun.map((entry) => entry.gateId)).toEqual(['unit-tests', 'typecheck'])
    expect(plan.rerun[0].reason).toContain('src/a.ts')
  })
})
