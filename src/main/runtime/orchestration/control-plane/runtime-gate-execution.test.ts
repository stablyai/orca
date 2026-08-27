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

  function store() {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  it('records what actually ran, and passes only on a zero exit', () => {
    const cp = store()
    const ok = runGate(cp, {
      scopeKey: SCOPE,
      gateId: 'unit',
      finalSha: SHA,
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(ok.passed).toBe(true)
    expect(ok.execution.exit_code).toBe(0)
    expect(ok.execution.command).toContain('node')
    expect(ok.execution.log_digest).toMatch(/^[0-9a-f]{32}$/)
    expect(hasRuntimeProvenGate(cp, { scopeKey: SCOPE, gateId: 'unit', finalSha: SHA })).toBe(true)
  })

  it('a failing gate leaves no successful execution to point at', () => {
    const cp = store()
    const failed = runGate(cp, {
      scopeKey: SCOPE,
      gateId: 'lint',
      finalSha: SHA,
      program: 'node',
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(failed.passed).toBe(false)
    expect(failed.execution.exit_code).toBe(3)
    expect(hasRuntimeProvenGate(cp, { scopeKey: SCOPE, gateId: 'lint', finalSha: SHA })).toBe(false)
  })

  it('a declared PASS with no execution proves nothing', () => {
    const cp = store()
    // Nothing ran. This is exactly the caller-declared PASS the old path took.
    expect(hasRuntimeProvenGate(cp, { scopeKey: SCOPE, gateId: 'unit', finalSha: SHA })).toBe(false)
  })

  it('an execution at another commit does not prove this one', () => {
    const cp = store()
    runGate(cp, {
      scopeKey: SCOPE,
      gateId: 'unit',
      finalSha: SHA,
      program: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      buildId: 'build-1'
    })
    expect(
      hasRuntimeProvenGate(cp, { scopeKey: SCOPE, gateId: 'unit', finalSha: 'b'.repeat(40) })
    ).toBe(false)
  })
})
