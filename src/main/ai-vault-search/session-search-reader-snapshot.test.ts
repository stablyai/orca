import { expect, it, vi } from 'vitest'
import { openSessionSearchHarness, addSyntheticSession } from './session-search-engine-test-fixture'

it('keeps a page on one read snapshot while commits invalidate later page requests', async () => {
  const harness = await openSessionSearchHarness('ss-reader-snapshot')
  const { db, store, engine } = harness
  addSyntheticSession(db, { id: 1, text: 'snapshotneedle' })
  addSyntheticSession(db, { id: 2, text: 'snapshotneedle' })
  const prepare = db.prepare.bind(db)
  let changed = false
  const boundary = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (sql.includes('SELECT value FROM meta')) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        const result = get(...args)
        if (!changed) {
          changed = true
          store.connection.prepare("UPDATE files SET state='due'").run()
        }
        return result
      }
    }
    return statement
  })
  try {
    const first = engine.search({ query: 'snapshotneedle', limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.page.cursor).toBeTruthy()
    boundary.mockRestore()
    expect(() =>
      engine.search({ query: 'snapshotneedle', limit: 1, cursor: first.page.cursor! })
    ).toThrow()
  } finally {
    boundary.mockRestore()
    await harness.close()
  }
})
