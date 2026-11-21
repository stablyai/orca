import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { workerContinues } from './bot-item-dispatch-facts'

/** One terminal held by `holders` Dispatches in turn, the last owning it; counts the reads. */
function reusedTerminal(holders: number) {
  const ids = Array.from({ length: holders }, (_, index) => `ctx_${index}`)
  const resource = {
    owner_dispatch_id: ids.at(-1)!,
    origin_dispatch_id: ids[0]!,
    prior_owner_dispatch_ids: JSON.stringify(ids.slice(0, -1))
  }
  const reads = { dispatch: 0, terminal: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the walk reads only these.
  const db = {
    getDispatchContextById: () => {
      reads.dispatch += 1
      return { follow_up_of_dispatch_id: null }
    },
    getWorkerTerminalResourceByOwner: (id: string) => {
      reads.terminal += 1
      return id === resource.owner_dispatch_id ? resource : undefined
    },
    getWorkerTerminalResourceFormerlyOwnedBy: (id: string) => {
      reads.terminal += 1
      return ids.includes(id) ? resource : undefined
    }
  } as unknown as OrchestrationDb
  return { db, last: ids.at(-1)!, reads }
}

it('reads a reused terminal once, however many Dispatches held it', () => {
  for (const holders of [11, 101]) {
    const { db, last, reads } = reusedTerminal(holders)
    expect(workerContinues(db, last)).toHaveLength(holders)
    expect(reads.terminal).toBe(1)
    expect(reads.dispatch).toBeLessThanOrEqual(2 * holders)
  }
})
