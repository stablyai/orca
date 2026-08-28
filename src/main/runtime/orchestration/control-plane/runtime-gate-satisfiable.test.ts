import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlaneStore } from './control-plane-store'
import { OrchestrationDb } from '../db'
import { createObservedWorktree, type ObservedWorktreeFixture } from './observed-worktree-fixture'
import { hasRuntimeProvenGate, runGate } from './runtime-gate-execution'

/** THE_GATE_MUST_BE_SATISFIABLE_BY_A_REAL_PROCESS
 *
 *  An independent review found that `runGate` — the half of the contract where
 *  the RUNTIME executes the gate — had no production caller. The completion gate
 *  demanded a proven gate for every receipt on an outcome-admitted Run, so no
 *  completion could ever be ACCEPTED: the package was a rejection machine, and
 *  every accepted-path test passed only because a fixture wrote the row itself.
 *
 *  These run real processes through the approved wrapper, so they fail if the
 *  execution path stops working rather than if a fixture stops being written.
 */
describe('THE_GATE_MUST_BE_SATISFIABLE_BY_A_REAL_PROCESS', () => {
  let db: OrchestrationDb | undefined
  let tree: ObservedWorktreeFixture | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    tree?.cleanup()
    tree = undefined
  })

  function world() {
    db = new OrchestrationDb(':memory:')
    tree = createObservedWorktree()
    return { store: new ControlPlaneStore(db), sha: tree.headSha, cwd: tree.path }
  }

  const scopeKey = 'run_1:out_1'

  it('a real zero-exit process makes the gate proven', () => {
    const { store, sha, cwd } = world()
    const result = runGate(store, {
      scopeKey,
      gateId: 'unit',
      finalSha: sha,
      program: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd,
      buildId: 'build-1'
    })
    expect(result.passed).toBe(true)
    expect(result.execution.exit_code).toBe(0)
    expect(hasRuntimeProvenGate(store, { scopeKey, gateId: 'unit', finalSha: sha })).toBe(true)
  })

  it('a real failing process does NOT make it proven', () => {
    const { store, sha, cwd } = world()
    const result = runGate(store, {
      scopeKey,
      gateId: 'unit',
      finalSha: sha,
      program: 'git',
      args: ['rev-parse', 'refs/heads/nope-does-not-exist'],
      cwd,
      buildId: 'build-1'
    })
    expect(result.passed).toBe(false)
    expect(hasRuntimeProvenGate(store, { scopeKey, gateId: 'unit', finalSha: sha })).toBe(false)
  })

  it('a proven gate is bound to its exact SHA and gate id', () => {
    const { store, sha, cwd } = world()
    runGate(store, {
      scopeKey,
      gateId: 'unit',
      finalSha: sha,
      program: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd,
      buildId: 'build-1'
    })
    const other = 'b'.repeat(40)
    expect(hasRuntimeProvenGate(store, { scopeKey, gateId: 'unit', finalSha: other })).toBe(false)
    expect(hasRuntimeProvenGate(store, { scopeKey, gateId: 'lint', finalSha: sha })).toBe(false)
    expect(
      hasRuntimeProvenGate(store, { scopeKey: 'other:out', gateId: 'unit', finalSha: sha })
    ).toBe(false)
  })

  it('records what actually ran, not what was asked for', () => {
    const { store, sha, cwd } = world()
    const { execution } = runGate(store, {
      scopeKey,
      gateId: 'unit',
      finalSha: sha,
      program: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd,
      buildId: 'build-7'
    })
    expect(execution.command).toBe('git rev-parse HEAD')
    expect(execution.build_id).toBe('build-7')
    expect(execution.log_digest).toMatch(/^[0-9a-f]{32}$/)
    expect(Date.parse(execution.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(execution.started_at)
    )
  })
})
