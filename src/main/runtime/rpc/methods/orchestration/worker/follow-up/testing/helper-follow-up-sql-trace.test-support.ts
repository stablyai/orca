import { vi } from 'vitest'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'

/** Calls of the per-Dispatch reads, by method and Dispatch id. */
export function traceDispatchProbes(db: OrchestrationDb) {
  const calls = new Map<string, number>()
  const count = (call: string) => calls.set(call, (calls.get(call) ?? 0) + 1)
  const dispatch = db.getDispatchContextById.bind(db)
  const owner = db.getWorkerTerminalResourceByOwner.bind(db)
  const spies = [
    vi.spyOn(db, 'getDispatchContextById').mockImplementation((id) => {
      count(`dispatch ${id}`)
      return dispatch(id)
    }),
    vi.spyOn(db, 'getWorkerTerminalResourceByOwner').mockImplementation((id) => {
      count(`owner ${id}`)
      return owner(id)
    })
  ]
  return {
    counts: () => ({
      total: [...calls.values()].reduce((sum, count) => sum + count, 0),
      perDispatch: Math.max(...calls.values())
    }),
    restore: () => spies.forEach((spy) => spy.mockRestore())
  }
}
