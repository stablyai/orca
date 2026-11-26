import { expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  deleteRetainedPlacementCatalog,
  readRetainedPlacementCatalog,
  writeRetainedPlacementCatalog
} from './worker-placement-catalog-store'

it('preserves a newer catalog when an older read finishes after replacement at the same timestamp', () => {
  const db = new OrchestrationDb(':memory:')
  const pin = {
    environment_id: 'server',
    peer_fingerprint: 'peer',
    home_fingerprint: 'home',
    pairing_revision: 1
  }
  const original = { observedAt: 1000, catalog: { repos: [], setups: [] } }
  try {
    const before = writeRetainedPlacementCatalog(db, pin, null, original)!
    deleteRetainedPlacementCatalog(db, 'server')
    writeRetainedPlacementCatalog(db, pin, null, {
      observedAt: 1000,
      catalog: { repos: [{ id: 'new', displayName: 'new', path: '/new' }], setups: [] }
    })
    writeRetainedPlacementCatalog(db, pin, before.version, original)
    expect(readRetainedPlacementCatalog(db, pin)).toMatchObject({
      value: { catalog: { repos: [{ id: 'new' }] } }
    })
  } finally {
    db.close()
  }
})
