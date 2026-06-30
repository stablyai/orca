import { describe, expect, it } from 'vitest'
import { createScryerIdMinter } from './id-minter'
import { createScryerSourceRouter } from './source-router'
import type { ScryModel } from './model'

function model(nodes: ScryModel['nodes']): ScryModel {
  return {
    version: '0.3',
    nodes,
    links: [],
    groups: [],
    sourceMap: {},
    boundaries: {}
  }
}

describe('Scryer id minter and source router', () => {
  it('mints ids from committed, planned, and current batch reservations', () => {
    const minter = createScryerIdMinter({
      committed: model([
        {
          id: 'node-4',
          kind: 'system',
          name: 'Committed',
          responsibilities: [{ id: 'resp-2', statement: 'committed' }]
        }
      ]),
      planned: {
        ...model([{ id: 'node-8', kind: 'system', name: 'Planned' }]),
        groups: [{ id: 'group-3', name: 'Group', memberIds: ['node-8'] }]
      },
      reserved: ['node-9', 'resp-9']
    })

    expect(minter.node()).toBe('node-10')
    expect(minter.responsibility()).toBe('resp-10')
    expect(minter.group()).toBe('group-4')
    expect(minter.link('api', 'db')).toBe('link-api-db')
    expect(() => minter.link('api', 'db')).toThrow("Scryer id 'link-api-db' is already reserved")
  })

  it('routes source entries to one owning layer without durable writes', () => {
    const committed = model([{ id: 'api', kind: 'system', name: 'API' }])
    const planned = model([
      { id: 'api', kind: 'system', name: 'API' },
      { id: 'worker', kind: 'system', name: 'Worker' }
    ])
    const router = createScryerSourceRouter()
    const committedDecision = router.routeSourceEntry({
      target: { kind: 'node', nodeId: 'api' },
      entry: [{ pattern: 'src/api.ts' }],
      committed,
      planned
    })
    const plannedDecision = router.routeBoundaryEntry({
      nodeId: 'worker',
      entry: [{ pattern: 'src/worker/**' }],
      committed,
      planned
    })

    expect(committedDecision).toMatchObject({
      targetKind: 'sourceMap',
      key: 'api',
      targetLayer: 'committed',
      clearOtherLayer: true
    })
    expect(plannedDecision).toMatchObject({
      targetKind: 'boundary',
      key: 'worker',
      targetLayer: 'planned',
      clearOtherLayer: true
    })

    const routed = router.applySourceRoutes({
      committed: { ...committed, sourceMap: {}, boundaries: {} },
      planned: { ...planned, sourceMap: { api: [{ pattern: 'shadow.ts' }] }, boundaries: {} },
      decisions: [committedDecision, plannedDecision]
    })

    expect(routed.committed.sourceMap).toEqual({ api: [{ pattern: 'src/api.ts' }] })
    expect(routed.planned.sourceMap).toEqual({})
    expect(routed.planned.boundaries).toEqual({ worker: [{ pattern: 'src/worker/**' }] })
  })
})
