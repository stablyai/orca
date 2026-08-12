import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

// Why: buildAgentOrchestrationByPaneKey issues 2 dispatch lookups per terminal
// on EVERY 16ms graph publish. For users who never orchestrate, every one of
// those queries returns nothing — pure main-thread SQLite churn. This bench
// proves the hasAnyDispatchContexts() short-circuit turns an N-terminal scan
// into a single cached probe, by counting the per-terminal
// getActiveDispatchForTerminal + getLatestDispatchForTerminal executions.

// Simulate the buildAgentOrchestrationByPaneKey per-terminal fan-out.
function simulateGraphPublish(db: OrchestrationDb, terminalHandles: string[]): number {
  if (db.hasAnyDispatchContexts() === false) {
    return 0
  }
  let contexts = 0
  for (const handle of terminalHandles) {
    const active = db.getActiveDispatchForTerminal(handle)
    const recent = active ?? db.getLatestDispatchForTerminal(handle)
    if (recent) {
      contexts++
    }
  }
  return contexts
}

describe('orchestration empty-dispatch short-circuit (benchmark)', () => {
  it('short-circuits the per-terminal query fan-out when no dispatch rows exist', () => {
    const db = new OrchestrationDb(':memory:')
    const handles = Array.from({ length: 100 }, (_, i) => `term_${i}`)

    // Instrument the real query methods to count executions.
    let queries = 0
    const wrap = <T extends (...a: never[]) => unknown>(fn: T): T =>
      ((...a: Parameters<T>) => {
        queries++
        return fn(...a)
      }) as T
    const original = {
      active: db.getActiveDispatchForTerminal.bind(db),
      latest: db.getLatestDispatchForTerminal.bind(db)
    }
    db.getActiveDispatchForTerminal = wrap(original.active)
    db.getLatestDispatchForTerminal = wrap(original.latest)

    // 60 publishes/s * 5s = 300 ticks, 100 terminals each.
    const TICKS = 300
    for (let t = 0; t < TICKS; t++) {
      simulateGraphPublish(db, handles)
    }

    // With the short-circuit, zero per-terminal dispatch queries execute.
    expect(queries).toBe(0)

    // Sanity: without the short-circuit it would have been 2 * 100 * 300.
    const wouldHaveBeen = 2 * handles.length * TICKS
    // eslint-disable-next-line no-console
    console.log(
      `[bench] empty-dispatch short-circuit: ${queries} dispatch queries over ${TICKS} publishes x ${handles.length} terminals (naive path would run ${wouldHaveBeen})`
    )
    expect(wouldHaveBeen).toBe(60000)
  })

  it('still runs the fan-out once a dispatch exists (correctness preserved)', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    db.createDispatchContext(task.id, 'term_5')
    const handles = Array.from({ length: 10 }, (_, i) => `term_${i}`)

    const contexts = simulateGraphPublish(db, handles)
    // term_5 has an active dispatch → its context is produced.
    expect(contexts).toBe(1)
  })

  it('predicate lifecycle: false when empty, true after dispatch (even completed), false after reset', () => {
    const db = new OrchestrationDb(':memory:')
    expect(db.hasAnyDispatchContexts()).toBe(false)
    const ctx = db.createDispatchContext(db.createTask({ spec: 'work' }).id, 'term_worker')
    expect(db.hasAnyDispatchContexts()).toBe(true)
    // Completed rows still count — recent-completed lookups must stay valid.
    db.completeDispatch(ctx.id)
    expect(db.hasAnyDispatchContexts()).toBe(true)
    db.resetTasks()
    expect(db.hasAnyDispatchContexts()).toBe(false)
  })
})
