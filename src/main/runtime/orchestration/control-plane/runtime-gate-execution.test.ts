import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { hasRuntimeProvenGate, runGate } from './runtime-gate-execution'

/** RUNTIME_OWNED_GATE_EXECUTION — `gates --record --result PASS` let a caller
 *  name the gate, the SHA and the verdict with nothing ever executing. A PASS
 *  now requires a row the runtime wrote after running the process itself.
 */
describe('RUNTIME_OWNED_GATE_EXECUTION', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const SCOPE = 'run_1:out_1'
  const SHA = 'a'.repeat(40)

  const authority = (gateId: string, finalSha = SHA) => ({
    scopeKey: SCOPE,
    gateId,
    finalSha,
    buildId: 'build-1',
    runId: 'run_1',
    outcomeId: 'out_1',
    dispatchId: 'ctx_1',
    worktreeId: 'repo::/tmp/worktree',
    policyVersion: 'v1',
    commandIdentity: gateId,
    specHash: `spec-${gateId}`,
    inputHashes: { 'file:fixture': 'hash' },
    shaBinding: 'exact_head' as const
  })

  const proof = (gateId: string, finalSha = SHA) => ({
    ...authority(gateId, finalSha),
    riskPolicy: 'standard' as const
  })

  function store() {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  it('records what actually ran, and passes only on a zero exit', () => {
    const cp = store()
    const ok = runGate(cp, {
      ...authority('unit'),
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(ok.passed).toBe(true)
    expect(ok.execution.exit_code).toBe(0)
    expect(ok.execution.command).toContain('node')
    expect(ok.execution.log_digest).toMatch(/^[0-9a-f]{32}$/)
    expect(hasRuntimeProvenGate(cp, proof('unit'))).toBe(true)
  })

  it('a failing gate leaves no successful execution to point at', () => {
    const cp = store()
    const failed = runGate(cp, {
      ...authority('lint'),
      program: 'node',
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(failed.passed).toBe(false)
    expect(failed.execution.exit_code).toBe(3)
    expect(hasRuntimeProvenGate(cp, proof('lint'))).toBe(false)
  })

  it('a declared PASS with no execution proves nothing', () => {
    const cp = store()
    // Nothing ran. This is exactly the caller-declared PASS the old path took.
    expect(hasRuntimeProvenGate(cp, proof('unit'))).toBe(false)
  })

  it('an execution at another commit does not prove this one', () => {
    const cp = store()
    runGate(cp, {
      ...authority('unit'),
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(hasRuntimeProvenGate(cp, proof('unit', 'b'.repeat(40)))).toBe(false)
  })

  it('reuses a standard content gate across a correction Dispatch only when inputs match', () => {
    const cp = store()
    runGate(cp, {
      ...authority('unit'),
      shaBinding: 'content',
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd()
    })
    const corrected = {
      ...proof('unit', 'b'.repeat(40)),
      dispatchId: 'ctx_2',
      shaBinding: 'content' as const
    }
    expect(hasRuntimeProvenGate(cp, corrected)).toBe(true)
    expect(
      hasRuntimeProvenGate(cp, {
        ...corrected,
        inputHashes: { 'file:fixture': 'changed' }
      })
    ).toBe(false)
  })

  it('never reuses an exact-head gate across a correction Dispatch', () => {
    const cp = store()
    runGate(cp, {
      ...authority('publish'),
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd()
    })
    expect(
      hasRuntimeProvenGate(cp, {
        ...proof('publish', 'b'.repeat(40)),
        dispatchId: 'ctx_2'
      })
    ).toBe(false)
  })
})
