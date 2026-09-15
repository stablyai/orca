import { describe, expect, it } from 'vitest'
import { exposeRun } from './run-receipt'
import type { RunRow } from '../../../../orchestration/types'

// Why: typecheck cannot see the strip because the RPC return types are loose.
const RUN_ROW: RunRow = {
  id: 'run_1',
  objective: 'Coordinate reviews',
  home_database: '/tmp/orca/orchestration.db',
  coordinator_handle: 'term_coord',
  coordinator_pane_key: 'tab_coord:11111111-1111-4111-8111-111111111111',
  consumer_generation: 3,
  legacy: 0,
  created_at: '2026-09-04T18:53:07Z',
  updated_at: '2026-09-04T18:53:09Z'
}

describe('exposeRun', () => {
  it('drops exactly the internal routing columns', () => {
    const exposed = exposeRun(RUN_ROW)

    expect(Object.keys(exposed).sort()).toEqual([
      'consumer_generation',
      'coordinator_handle',
      'created_at',
      'id',
      'legacy',
      'objective',
      'updated_at'
    ])
    expect(exposed).not.toHaveProperty('home_database')
    expect(exposed).not.toHaveProperty('coordinator_pane_key')
  })

  it('preserves every published column by value', () => {
    const exposed = exposeRun(RUN_ROW)

    expect(exposed).toEqual({
      id: 'run_1',
      objective: 'Coordinate reviews',
      coordinator_handle: 'term_coord',
      consumer_generation: 3,
      legacy: 0,
      created_at: '2026-09-04T18:53:07Z',
      updated_at: '2026-09-04T18:53:09Z'
    })
  })

  it('does not mutate the source row', () => {
    const row = { ...RUN_ROW }
    exposeRun(row)

    expect(row).toEqual(RUN_ROW)
  })

  it('strips the columns even when they are null', () => {
    const exposed = exposeRun({ ...RUN_ROW, coordinator_pane_key: null })

    expect(exposed).not.toHaveProperty('coordinator_pane_key')
  })
})
