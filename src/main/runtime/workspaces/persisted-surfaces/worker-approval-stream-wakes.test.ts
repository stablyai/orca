import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { isOrcaSessionId } from '../../../../shared/orca-session-address'

const CHAT = 'claude_11111111_1111_4111_8111_111111111111'

it("reads a chat's approvals on its own Run's changes, never on terminal identity notices", async () => {
  if (!isOrcaSessionId(CHAT)) {
    throw new Error('fixture id')
  }
  const runtime = new OrcaRuntimeService()
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const runs = vi.spyOn(db, 'runsBoundToCoordinator')
  const stop = runtime.subscribeOrchestrationWorkerApprovals(`orca_session_id:${CHAT}`, () => {})
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const reads = runs.mock.calls.length

  // What every agent status or tab title change sends: terminal identity's default topology notice.
  for (let i = 0; i < 50; i++) {
    runtime.crewChanges.notify()
    await settle()
  }
  expect(runs.mock.calls.length - reads).toBe(0)

  db.createRun({
    objective: 'Coordinate',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: CHAT
  })
  await settle()
  expect(runs.mock.calls.length - reads).toBe(1)
  stop()
})
