import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { fingerprintGateDependencies, parseGateDependencySpec } from './gate-dependency-fingerprint'
import { planGateSet, recordGateReceipt, type GateInputs } from './gate-receipt-validity'

/** INCREMENTAL_GATE_REUSE — receipts fingerprinted the PATH string, and every
 *  gate in a request shared one input set bound to the commit SHA. So editing a
 *  file invalidated nothing, one file change reran every gate, and any new
 *  commit reran all of them regardless.
 */
describe('INCREMENTAL_GATE_REUSE', () => {
  let db: OrchestrationDb | undefined
  let dir: string | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  const SCOPE = 'run_1:out_1'
  const SHA_A = 'aaaaaaaaaaaa'
  const SHA_B = 'bbbbbbbbbbbb'

  function world() {
    db = new OrchestrationDb(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'orca-gate-'))
    writeFileSync(join(dir, 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'y.ts'), 'export const y = 1\n')
    return new ControlPlaneStore(db)
  }

  function gate(gateId: string, spec: string, sha: string): GateInputs {
    const parsed = parseGateDependencySpec(spec)
    return {
      gateId,
      finalSha: sha,
      inputHashes: fingerprintGateDependencies({
        spec: parsed,
        fallbackFiles: [],
        cwd: dir as string,
        policyVersion: 'v1',
        commandIdentity: gateId
      }),
      policyVersion: 'v1',
      commandIdentity: gateId,
      shaBinding: gateId.includes('review') ? 'exact_head' : 'content'
    }
  }

  it('invalidates only the gate whose own dependency changed', () => {
    const store = world()
    const gateX = gate('gate-x', 'gate-x=x.ts', SHA_A)
    const gateY = gate('gate-y', 'gate-y=y.ts', SHA_A)
    const at = '2026-08-27T18:00:00Z'
    recordGateReceipt(store, { scopeKey: SCOPE, inputs: gateX, result: 'PASS', recordedAt: at })
    recordGateReceipt(store, { scopeKey: SCOPE, inputs: gateY, result: 'PASS', recordedAt: at })

    writeFileSync(join(dir as string, 'x.ts'), 'export const x = 2\n')
    const plan = planGateSet({
      store,
      scopeKey: SCOPE,
      gates: [gate('gate-x', 'gate-x=x.ts', SHA_A), gate('gate-y', 'gate-y=y.ts', SHA_A)]
    })
    expect(plan.rerun.map((entry) => entry.gateId)).toEqual(['gate-x'])
    expect(plan.reuse.map((entry) => entry.gateId)).toEqual(['gate-y'])
  })

  it('reuses byte-identical inputs across a Git SHA, and never for an exact-head gate', () => {
    const store = world()
    const at = '2026-08-27T18:00:00Z'
    recordGateReceipt(store, {
      scopeKey: SCOPE,
      inputs: gate('gate-y', 'gate-y=y.ts', SHA_A),
      result: 'PASS',
      recordedAt: at
    })
    recordGateReceipt(store, {
      scopeKey: SCOPE,
      inputs: gate('review-gate', 'review-gate=y.ts', SHA_A),
      result: 'PASS',
      recordedAt: at
    })

    // A correction commit moves the SHA while y.ts is untouched.
    const plan = planGateSet({
      store,
      scopeKey: SCOPE,
      gates: [gate('gate-y', 'gate-y=y.ts', SHA_B), gate('review-gate', 'review-gate=y.ts', SHA_B)]
    })
    expect(plan.reuse.map((entry) => entry.gateId)).toEqual(['gate-y'])
    expect(plan.rerun.map((entry) => entry.gateId)).toEqual(['review-gate'])
    expect(plan.rerun[0].reason).toMatch(/exact head/i)
  })

  it('same path, different contents is never reusable', () => {
    const store = world()
    recordGateReceipt(store, {
      scopeKey: SCOPE,
      inputs: gate('gate-x', 'gate-x=x.ts', SHA_A),
      result: 'PASS',
      recordedAt: '2026-08-27T18:00:00Z'
    })
    writeFileSync(join(dir as string, 'x.ts'), 'export const x = 999\n')
    const plan = planGateSet({
      store,
      scopeKey: SCOPE,
      gates: [gate('gate-x', 'gate-x=x.ts', SHA_A)]
    })
    expect(plan.reuse).toEqual([])
    expect(plan.rerun[0].reason).toMatch(/Inputs changed/)
  })

  it('fingerprints bytes, not paths, and folds gate configuration in', () => {
    world()
    const spec = parseGateDependencySpec('gate-x=x.ts')
    const before = fingerprintGateDependencies({
      spec,
      fallbackFiles: [],
      cwd: dir as string,
      policyVersion: 'v1',
      commandIdentity: 'gate-x'
    })
    writeFileSync(join(dir as string, 'x.ts'), 'changed\n')
    const after = fingerprintGateDependencies({
      spec,
      fallbackFiles: [],
      cwd: dir as string,
      policyVersion: 'v1',
      commandIdentity: 'gate-x'
    })
    expect(after['file:x.ts']).not.toBe(before['file:x.ts'])
    // A gate whose policy version moved is a different gate.
    const rebadged = fingerprintGateDependencies({
      spec,
      fallbackFiles: [],
      cwd: dir as string,
      policyVersion: 'v2',
      commandIdentity: 'gate-x'
    })
    expect(rebadged['config:policyVersion']).not.toBe(after['config:policyVersion'])
    // A missing dependency is recorded as absent, never as "unchanged".
    const missing = fingerprintGateDependencies({
      spec: parseGateDependencySpec('gate-x=nope.ts'),
      fallbackFiles: [],
      cwd: dir as string,
      policyVersion: 'v1',
      commandIdentity: 'gate-x'
    })
    expect(missing['file:nope.ts']).toBe('absent')
  })

  it('never reuses a gate whose declared dependency the runtime could not read', () => {
    const store = world()
    const at = '2026-08-27T18:00:00Z'
    const present = gate('gate-x', 'gate-x=x.ts', SHA_A)
    recordGateReceipt(store, { scopeKey: SCOPE, inputs: present, result: 'PASS', recordedAt: at })
    expect(planGateSet({ store, scopeKey: SCOPE, gates: [present] }).reuse).toHaveLength(1)

    // The same gate, resolved against a root where its dependency does not
    // exist. Two "absent" fingerprints compare equal, so without failing closed
    // this reads as "nothing changed" and reuses a receipt it never proved.
    const unresolvable = {
      ...present,
      inputHashes: fingerprintGateDependencies({
        spec: parseGateDependencySpec('gate-x=x.ts'),
        fallbackFiles: [],
        cwd: join(dir as string, 'nowhere'),
        policyVersion: 'v1',
        commandIdentity: 'gate-x'
      })
    }
    const plan = planGateSet({ store, scopeKey: SCOPE, gates: [unresolvable] })
    expect(plan.reuse).toEqual([])
    expect(plan.rerun[0].reason).toMatch(/could not read/)
  })

  it('never reuses a gate that declares no real inputs at all', () => {
    const store = world()
    // Config-only inputs never change with the tree, so a receipt built from
    // them alone could never be invalidated by anything — a permanent PASS.
    const configOnly = {
      gateId: 'gate-empty',
      finalSha: SHA_A,
      inputHashes: { 'config:policyVersion': 'v1', 'config:commandIdentity': 'gate-empty' },
      policyVersion: 'v1',
      commandIdentity: 'gate-empty'
    }
    recordGateReceipt(store, {
      scopeKey: SCOPE,
      inputs: configOnly,
      result: 'PASS',
      recordedAt: '2026-08-27T18:00:00Z'
    })
    const plan = planGateSet({ store, scopeKey: SCOPE, gates: [configOnly] })
    expect(plan.reuse).toEqual([])
    expect(plan.rerun[0].reason).toMatch(/declares no file inputs/)
  })
})
