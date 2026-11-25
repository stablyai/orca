import { expect, it } from 'vitest'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { exposeRunCoordinator } from './run-coordinator-receipt'

const SESSION = testOrcaSessionId('7b0c4c55-1f7e-4c55-9d43-1b1a8c3c0a01')

function createRun(coordinatorHandle: string | null) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'inspect me',
    coordinatorHandle,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: coordinatorHandle === null ? SESSION : null
  })
  return { db, run }
}

it('names a chat coordinator by its session address', () => {
  const { db, run } = createRun(null)
  try {
    expect(exposeRunCoordinator(run, 'runtime-1')).toEqual({
      run_id: run.id,
      actor: `orca_session_id:${SESSION}`,
      consumer_generation: run.consumer_generation,
      runtime_id: 'runtime-1'
    })
  } finally {
    db.close()
  }
})

it('names a terminal coordinator by its handle', () => {
  const { db, run } = createRun('term_7')
  try {
    expect(exposeRunCoordinator(run, 'runtime-2').actor).toBe('term_7')
  } finally {
    db.close()
  }
})

it('reports an unknown actor when the session id belongs to an older generation', () => {
  const { db, run } = createRun(null)
  try {
    db.db
      .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
      .run(run.id)
    const receipt = exposeRunCoordinator(db.getRun(run.id)!, 'runtime-3')
    expect(receipt.actor).toBeNull()
    expect(receipt.consumer_generation).toBe(run.consumer_generation + 1)
  } finally {
    db.close()
  }
})
