import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db'

const CHAT = 'orca_session_id:3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26'

let db: OrchestrationDb

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

function dispatchTo(assigneeHandle: string) {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  return db.createDispatchContext({
    taskId: task.id,
    assigneeHandle,
    creator: { kind: 'system' },
    maxDepth: 9
  })
}

/** The whole refusal message: a substring match would accept a "Terminal " prefix. */
function refusalOf(dispatch: () => unknown): string {
  try {
    dispatch()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a refusal')
}

describe("an assignee's second active Dispatch", () => {
  it('names a chat by its Orca session ID when the claim loses the race, never as a terminal', () => {
    db = new OrchestrationDb(':memory:')
    const owner = dispatchTo(CHAT)
    // The precheck misses the owner, as a concurrent writer's claim would; the claim then loses.
    vi.spyOn(db, 'findActiveDispatchForAssignee').mockReturnValueOnce(undefined)

    expect(refusalOf(() => dispatchTo(CHAT))).toBe(
      `${CHAT} already has an active dispatch (${owner.id} for task ${owner.task_id})`
    )
  })

  it('keeps naming a terminal as main does', () => {
    db = new OrchestrationDb(':memory:')
    const owner = dispatchTo('term_worker')
    vi.spyOn(db, 'findActiveDispatchForAssignee').mockReturnValueOnce(undefined)

    expect(refusalOf(() => dispatchTo('term_worker'))).toBe(
      `Terminal term_worker already has an active dispatch (${owner.id} for task ${owner.task_id})`
    )
  })
})
