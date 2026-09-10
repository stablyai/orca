import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab_coord:${LEAF}`
const SESSION_ID = 'session-alpha-1'
const SESSION_BINDING = {
  principalId: `session:${SESSION_ID}`,
  terminalHandle: 'structworker_11111111-2222-4333-8444-555555555555',
  paneKey: `structured-agent-session-${SESSION_ID}:${LEAF}`
}

describe('run coordinator principal binding', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('derives the principal from the legacy handle+pane createRun shape', () => {
    const d = createDb()
    const run = d.createRun({
      objective: 'Legacy shape',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE_KEY
    })
    const raw = d.getRunRaw(run.id)!
    expect(raw.coordinator_principal).toBe(`pane:${PANE_KEY}`)
    expect(raw.coordinator_handle).toBe('term_coord')
    expect(raw.coordinator_pane_key).toBe(PANE_KEY)
  })

  it('writes all three coordinator columns from a resolver binding', () => {
    const d = createDb()
    const run = d.createRun({ objective: 'Session binding', coordinator: SESSION_BINDING })
    const raw = d.getRunRaw(run.id)!
    expect(raw.coordinator_principal).toBe(SESSION_BINDING.principalId)
    expect(raw.coordinator_handle).toBe(SESSION_BINDING.terminalHandle)
    expect(raw.coordinator_pane_key).toBe(SESSION_BINDING.paneKey)
  })

  it('unbinds other runs for the principal: nulls all three columns, bumps the generation, fences delivery', () => {
    const d = createDb()
    const run = d.createRun({ objective: 'To unbind', coordinator: SESSION_BINDING })
    d.insertMessage({ from: 'a', to: `run:${run.id}`, subject: 'pending', runId: run.id })
    const delivery = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!

    d.unbindOtherRunsForPrincipal(SESSION_BINDING.principalId)

    const raw = d.getRunRaw(run.id)!
    expect(raw.coordinator_principal).toBeNull()
    expect(raw.coordinator_handle).toBeNull()
    expect(raw.coordinator_pane_key).toBeNull()
    expect(raw.consumer_generation).toBe(run.consumer_generation + 1)
    const status = d.db
      .prepare('SELECT status FROM deliveries WHERE id = ?')
      .get(delivery.delivery.id) as { status: string }
    expect(status.status).toBe('fenced')
  })

  it('keeps the exempted run bound while unbinding its siblings', () => {
    const d = createDb()
    const kept = d.createRun({ objective: 'Kept', coordinator: SESSION_BINDING })
    d.unbindOtherRunsForPrincipal(SESSION_BINDING.principalId, kept.id)
    expect(d.getRunRaw(kept.id)!.coordinator_principal).toBe(SESSION_BINDING.principalId)
  })

  it('recognizes the same pane binding across a tab-half remint and does not rebump it', () => {
    const d = createDb()
    const run = d.createRun({
      objective: 'Remint',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE_KEY
    })
    const rebound = d.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: `tab_reminted:${LEAF}`
    })!
    expect(rebound.consumer_generation).toBe(run.consumer_generation)
    expect(d.getRunRaw(run.id)!.coordinator_pane_key).toBe(PANE_KEY)
  })

  it('recognizes the same session binding and does not rebump it', () => {
    const d = createDb()
    const run = d.createRun({ objective: 'Session stable', coordinator: SESSION_BINDING })
    const rebound = d.bindRun({ runId: run.id, coordinator: SESSION_BINDING })!
    expect(rebound.consumer_generation).toBe(run.consumer_generation)
  })

  it('bumps the generation when the coordinator principal actually changes kind', () => {
    const d = createDb()
    const run = d.createRun({
      objective: 'Handover',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE_KEY
    })
    const rebound = d.bindRun({ runId: run.id, coordinator: SESSION_BINDING })!
    expect(rebound.consumer_generation).toBe(run.consumer_generation + 1)
    const raw = d.getRunRaw(run.id)!
    expect(raw.coordinator_principal).toBe(SESSION_BINDING.principalId)
    expect(raw.coordinator_handle).toBe(SESSION_BINDING.terminalHandle)
  })
})
