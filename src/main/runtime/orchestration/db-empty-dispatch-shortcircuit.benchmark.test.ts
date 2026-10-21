import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

// Why: runtime-agent-orchestration-projection skips its per-terminal dispatch
// fan-out on every 16ms graph publish while hasAnyDispatchContexts() is false,
// so the cached predicate must flip exactly when dispatch rows appear and go.
describe('orchestration empty-dispatch short-circuit (benchmark)', () => {
  it('predicate lifecycle: false when empty, true after dispatch (even completed), false after reset', () => {
    const db = new OrchestrationDb(':memory:')
    expect(db.hasAnyDispatchContexts()).toBe(false)
    const ctx = createRootDispatch(
      db,
      db.createTask({ runId: 'run_legacy_local', spec: 'work' }).id,
      'term_worker'
    )
    expect(db.hasAnyDispatchContexts()).toBe(true)
    // Completed rows still count — recent-completed lookups must stay valid.
    db.completeDispatch(ctx.id)
    expect(db.hasAnyDispatchContexts()).toBe(true)
    db.resetTasks()
    expect(db.hasAnyDispatchContexts()).toBe(false)
  })
})
