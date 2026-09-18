import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyCellRowLockScopeCounts } from './cell-row-lock-scope.js'
import {
  consumeRelayCellRowLockScope,
  openInMemoryRelayDatabase,
  openRelayDatabase,
  type RelayDatabase
} from './database.js'

// Driven through the real database so the assertions cover the hook in the
// transaction classes, not a scope object held on its own: unwire either
// constructor in database.ts and every rejection below turns into a resolution.
// Run on both dialects because "identical on Postgres and SQLite" is the design
// claim that lets the cheap suite prove the invariant.

const PREFIX = 'lock-scope'
const CELL_A = `${PREFIX}-a`
const CELL_B = `${PREFIX}-b`
const CELL_C = `${PREFIX}-c`
// Sorts below every seeded cell, so inserting it proves the insert exemption.
const CELL_BELOW = `${PREFIX}-0`
// Sorts below CELL_B under code units and equal to it under a punctuation-
// insensitive collation, so its order against CELL_B is not knowable here.
const CELL_AMBIGUOUS = `${PREFIX}b`

const LOCK_ONE = `SELECT * FROM relay_cells WHERE cell_id = ?`
const INVENTORY_LOCK = `SELECT * FROM relay_cells ORDER BY cell_id ASC`
const UNORDERED_LOCK = `SELECT * FROM relay_cells`
const RESERVE = `UPDATE relay_cells SET reserved_requests = ?, updated_at = ? WHERE cell_id = ?`
const INSERT_CELL = `INSERT INTO relay_cells
 (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
  observed_requests, last_heartbeat_at, updated_at)
 VALUES (?, ?, 1, 10, 0, 0, 0, 0)`

const VIOLATION = 'cell_row_lock_scope_violation'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const backends: { name: string; open: () => Promise<RelayDatabase> }[] = [
  { name: 'sqlite', open: openInMemoryRelayDatabase },
  ...(databaseUrl
    ? [{ name: 'postgres', open: () => openRelayDatabase({ databaseUrl, dataDir: '' }) }]
    : [])
]

const opened: RelayDatabase[] = []

afterAll(async () => {
  for (const database of opened.splice(0)) await database.close()
})

describe.each(backends)('cell row lock scope ($name)', ({ name, open }) => {
  let database: RelayDatabase

  // The Postgres backend is one shared CI database, so these rows are scoped by
  // prefix and removed on both sides of every test: a leftover cell fails the
  // later suites that assert on the whole inventory.
  async function removeScopedCells(): Promise<void> {
    for (const table of ['relay_cell_regions', 'relay_cells']) {
      await database.query(`DELETE FROM ${table} WHERE cell_id LIKE '${PREFIX}%'`)
    }
  }

  beforeEach(async () => {
    if (!database) {
      database = await open()
      opened.push(database)
    }
    await removeScopedCells()
    for (const cellId of [CELL_A, CELL_B, CELL_C]) {
      await database.query(INSERT_CELL, [cellId, `https://${cellId}.example`])
    }
  })

  afterEach(removeScopedCells)

  it('lets a fleet-wide lock cover every later single-cell write', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(INVENTORY_LOCK)
        await transaction.query(RESERVE, [1, 0, CELL_C])
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).resolves.toBeUndefined()
  })

  // Why: this is the case a per-statement sort check cannot see. Each statement
  // locks one row and is trivially ordered; the transaction's sequence descends,
  // and a second transaction running it the other way round deadlocks.
  it('catches a descending sequence of individually sorted locks', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.queryLocked(LOCK_ONE, [CELL_A])
      })
    ).rejects.toThrow('out-of-order')
  })

  it('allows an ascending sequence of single-row locks', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_A])
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
      })
    ).resolves.toBeUndefined()
  })

  // Why: NOWAIT either takes the row at once or fails, so it can never be an edge
  // in a wait-for cycle and its place in the order cannot matter. The sweeps and
  // the contention probes in this suite rely on that.
  it('exempts a NOWAIT acquisition from the order', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.queryLocked(LOCK_ONE, [CELL_A], { failIfUnavailable: true })
      })
    ).resolves.toBeUndefined()
  })

  // Why: the exemption covers the NOWAIT acquisition itself, not what follows.
  // A row taken without waiting is still held, and a later wait below it is the
  // edge that closes a cycle.
  it('still catches a wait below a row taken with NOWAIT', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C], { failIfUnavailable: true })
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).rejects.toThrow('out-of-order')
  })

  it('catches a write below a row the transaction already holds', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).rejects.toThrow(VIOLATION)
  })

  it('treats an insert as extending what is held rather than reordering it', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.query(INSERT_CELL, [CELL_BELOW, `https://${CELL_BELOW}.example`])
        await transaction.query(RESERVE, [1, 0, CELL_BELOW])
      })
    ).resolves.toBeUndefined()
  })

  // The release and acquire paths take one cell row late, with the atomic write
  // itself, and hold nothing else; adjustCellReservationAtomically exists for it.
  it('allows a row locked late by its own write', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(RESERVE, [1, 0, CELL_B])
        await transaction.query(RESERVE, [2, 0, CELL_B])
      })
    ).resolves.toBeUndefined()
  })

  // Why: an unlocked read is exactly the mistake the guard exists to catch, so
  // it must not be able to authorise the writes that follow it.
  it('does not let an unlocked read hold anything', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(INVENTORY_LOCK)
        await transaction.query(RESERVE, [1, 0, CELL_C])
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).rejects.toThrow(VIOLATION)
  })

  it('catches a multi-row lock that does not name its order', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(UNORDERED_LOCK)
      })
    ).rejects.toThrow('unordered-lock')
  })

  it('reports a relay_cells write that names no cell at all', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(INVENTORY_LOCK)
        await transaction.query(`UPDATE relay_cells SET updated_at = ? WHERE cell_url LIKE ?`, [
          1,
          `https://${PREFIX}-%`
        ])
      })
    ).rejects.toThrow('unparsed-write')
  })

  // Why: ORDER BY uses the column collation, which may rank punctuation
  // differently from JS. Reporting a pair the two disagree about would put noise
  // into the one production signal this guard exists to keep clean.
  it('stays silent where the two orderings disagree', async () => {
    await database.query(INSERT_CELL, [CELL_AMBIGUOUS, `https://${CELL_AMBIGUOUS}.example`])

    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_AMBIGUOUS])
        await transaction.queryLocked(LOCK_ONE, [CELL_B])
      })
    ).resolves.toBeUndefined()
  })

  // Why: every table that joins relay_cells carries a cell_id of its own, so a
  // locked read of one of those would otherwise be taken for a set of held cell
  // rows the transaction does not hold.
  it('declares nothing for a locked read whose own relation is another table', async () => {
    await database.query(`INSERT INTO relay_cell_regions (cell_id, region) VALUES (?, ?)`, [
      CELL_C,
      'us-central1'
    ])

    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(
          `SELECT * FROM relay_cell_regions WHERE EXISTS (
             SELECT 1 FROM relay_cells WHERE relay_cells.cell_id = relay_cell_regions.cell_id
           )`
        )
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).resolves.toBeUndefined()
  })

  // Why: a locking read is checked, not only recorded. Taking one row late and
  // then taking the inventory ascending walks below the row already held.
  it('catches an inventory lock taken after a row was locked late', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(RESERVE, [1, 0, CELL_C])
        await transaction.queryLocked(INVENTORY_LOCK)
      })
    ).rejects.toThrow('out-of-order')
  })

  // Nothing locks relay_cells without selecting cell_id today. If something does,
  // standing down beats guessing -- a spurious production warning on a shape the
  // guard cannot read would be indistinguishable from the real thing.
  it('stands down on a locked read whose rows do not name their cell', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(
          `SELECT capacity_requests FROM relay_cells WHERE cell_id = ?`,
          [CELL_C]
        )
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).resolves.toBeUndefined()
  })

  it('scopes what is held to one transaction', async () => {
    for (const cellId of [CELL_C, CELL_A]) {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.query(RESERVE, [1, 0, cellId])
        })
      ).resolves.toBeUndefined()
    }
  })

  // Why: the deploy plan is to ship warn-only and trust the guard's silence.
  // Silence is only evidence next to a count of what was examined -- otherwise it
  // reads the same whether the invariant holds, the guard stood down, or nothing
  // ever reached it.
  it('counts the transactions it examined', async () => {
    consumeRelayCellRowLockScope(database)

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(INVENTORY_LOCK)
      await transaction.query(RESERVE, [1, 0, CELL_A])
    })

    expect(consumeRelayCellRowLockScope(database)).toEqual({
      cellRowLockScopesChecked: 1,
      cellRowLockScopesStoodDown: 0,
      cellRowLockScopeViolations: 0
    })
  })

  it('counts a stand-down instead of letting it read as a clean run', async () => {
    consumeRelayCellRowLockScope(database)

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT capacity_requests FROM relay_cells WHERE cell_id = ?`,
        [CELL_C]
      )
      await transaction.query(RESERVE, [1, 0, CELL_A])
    })

    // checked is 1, not 0: standing down is now scoped to the statement it could
    // not read, so the write after it was still judged. That is the point --
    // muting a whole transaction over one unreadable projection was the hazard.
    expect(consumeRelayCellRowLockScope(database)).toMatchObject({
      cellRowLockScopesChecked: 1,
      cellRowLockScopesStoodDown: 1
    })
  })

  // Why: a violation throws in tests and rolls the transaction back, which is
  // exactly the transaction whose count must not disappear with it.
  it('counts a violation from the transaction that failed on it', async () => {
    consumeRelayCellRowLockScope(database)

    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).rejects.toThrow(VIOLATION)

    expect(consumeRelayCellRowLockScope(database)).toEqual({
      cellRowLockScopesChecked: 1,
      cellRowLockScopesStoodDown: 0,
      cellRowLockScopeViolations: 1
    })
  })

  // PINS A KNOWN GAP, deliberately. A colliding upsert waits on the row it hits,
  // so this transaction really is acquiring CELL_A below CELL_C and the guard
  // says nothing. It is latent while every upsert site takes the fleet-wide lock
  // first, and it becomes reachable with the per-cell conversion -- which is when
  // it has to be closed, by making create-versus-collide explicit rather than
  // guessed. If someone closes it, this test fails and should be inverted; that
  // is the point of writing the hole down instead of leaving it in a comment.
  it('does not yet order a colliding upsert', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.query(`${INSERT_CELL} ON CONFLICT (cell_id) DO UPDATE SET enabled = 1`, [
          CELL_A,
          `https://${CELL_A}.example`
        ])
      })
    ).resolves.toBeUndefined()
  })

  // Why: an insert shape the parser cannot read used to match no branch at all --
  // not the insert path, not the write path, not the read path -- so it produced
  // no report and no stand-down. A statement that falls through every branch is
  // the one failure a guard sold on its silence must never have.
  it('reports an insert shape it cannot read instead of skipping it', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(INVENTORY_LOCK)
        // Matches nothing, so the statement itself succeeds and the guard is
        // judged on the shape rather than on a constraint failure.
        await transaction.query(
          `INSERT INTO relay_cells SELECT * FROM relay_cells WHERE cell_id = ?`,
          [`${PREFIX}-absent`]
        )
      })
    ).rejects.toThrow('unparsed-write')
  })

  it('still treats a plain insert as free, since nobody could hold that row', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.query(INSERT_CELL, [CELL_BELOW, `https://${CELL_BELOW}.example`])
      })
    ).resolves.toBeUndefined()
  })

  // Why: `checked` is the denominator for "the guard saw the population a per-cell
  // conversion moves", and that population is every transaction taking a cell row
  // lock. Counting only writes missed 44% of them across this suite -- including
  // the fleet-wide lock the conversion replaces, which scored zero.
  it('counts a transaction that only took a locked read', async () => {
    consumeRelayCellRowLockScope(database)

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(INVENTORY_LOCK)
    })

    expect(consumeRelayCellRowLockScope(database)).toEqual({
      cellRowLockScopesChecked: 1,
      cellRowLockScopesStoodDown: 0,
      cellRowLockScopeViolations: 0
    })
  })

  // Why shape and not row count: a lock naming no single cell can return one row
  // in a fixture and many in production. Judging it by what came back makes the
  // ratchet depend on the seed data.
  it('reports an unordered multi-row lock even when one row comes back', async () => {
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [CELL_A, CELL_B])

    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(UNORDERED_LOCK)
      })
    ).rejects.toThrow('unordered-lock')
  })
  // Autocommit statements each commit on their own, so there is no order to
  // police and the guard must stay out of the way.
  it('leaves statements outside a transaction alone', async () => {
    await expect(database.query(RESERVE, [1, 0, CELL_C])).resolves.toBeDefined()
    await expect(database.query(RESERVE, [1, 0, CELL_A])).resolves.toBeDefined()
  })

  // Why: standing down silently reads exactly like a clean transaction, which is
  // the failure this guard's own comment forbids. The counter alone is not enough
  // -- an operator reading logs must see it.
  // The distinct column list is load-bearing: warnings dedupe once per signature
  // for the life of the process, so a statement another test already reported
  // would warn nowhere here. Recurrence is carried by the counter, not the log.
  // The distinct column list is load-bearing: warnings dedupe once per signature
  // for the life of the process, so a statement another test already reported
  // would warn nowhere here. Recurrence is carried by the counter, not the log.
  it('warns when it stands down, not only counts', async () => {
    const events: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      events.push(String(line))
    })
    try {
      await database.transaction(async (transaction) => {
        await transaction.queryLocked(`SELECT enabled FROM relay_cells WHERE cell_id = ?`, [
          CELL_B
        ])
      })
    } finally {
      warn.mockRestore()
    }

    expect(consumeRelayCellRowLockScope(database).cellRowLockScopesStoodDown).toBe(1)
    expect(events.some((line) => line.includes('orca_relay_cell_row_lock_scope_stood_down'))).toBe(
      true
    )
  })

  // Why: a statement the scope cannot read must not mute the ones after it. The
  // read below contributes nothing to `held`, and a missing `held` entry can only
  // ever remove a report -- so continuing to police is strictly safer than
  // latching off, and the descending write after it is still caught.
  it('keeps policing after a statement it could not read', async () => {
    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(LOCK_ONE, [CELL_C])
        await transaction.queryLocked(
          `SELECT capacity_requests FROM relay_cells WHERE cell_id = ?`,
          [CELL_B]
        )
        await transaction.query(RESERVE, [1, 0, CELL_A])
      })
    ).rejects.toThrow('out-of-order')
  })

  // Why: production is the configuration that actually ships. "Tests throw,
  // production warns" was half-tested -- nothing exercised the warn, nor the
  // once-per-signature dedupe that bounds it.
  it('warns instead of throwing when it is not running under test', async () => {
    consumeRelayCellRowLockScope(database)
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const events: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      events.push(String(line))
    })
    try {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.queryLocked(LOCK_ONE, [CELL_C])
          // The backend name is in the statement on purpose, and early in it.
          // Warnings dedupe by statement for the life of the process, and this
          // write's text is identical on both dialects -- unlike a locked read,
          // which Postgres rewrites with FOR UPDATE -- so the second backend
          // would otherwise assert on a warning the first one consumed. The
          // dedupe key is the first 80 characters, so the marker has to fit
          // inside them.
          await transaction.query(
            `UPDATE relay_cells SET observed_requests = ? WHERE cell_id = ? AND '${name}'='${name}'`,
            [1, CELL_A]
          )
        })
      ).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
      process.env.NODE_ENV = previous
    }

    expect(
      events.some((line) => line.includes('orca_relay_cell_row_lock_scope_violation'))
    ).toBe(true)
    expect(consumeRelayCellRowLockScope(database).cellRowLockScopeViolations).toBe(1)
  })
})

// Why a source assertion: deleting the drain from the runtime-metrics snapshot
// left every other test green. The whole warn-only deploy rests on reading these
// counters from a live log line, so "the counters are computed correctly" is not
// the property that matters -- "the counters reach the event" is.
describe('cell row lock scope counters reach production', () => {
  const sourceDirectory = fileURLToPath(new URL('.', import.meta.url))
  const counterNames = Object.keys(emptyCellRowLockScopeCounts())
  const terraform = () =>
    readFileSync(join(sourceDirectory, '../../../infra/terraform/relay-observability.tf'), 'utf8')
  const declaredFields = () =>
    [...terraform().matchAll(/field\s*=\s*"([^"]+)"/g)].map((match) => match[1])

  it('drains the scope counters into the runtime metrics snapshot', () => {
    const entry = readFileSync(join(sourceDirectory, 'index.ts'), 'utf8')
    const start = entry.indexOf('observability.start(')
    expect(start).toBeGreaterThan(-1)
    const snapshot = entry.slice(start, entry.indexOf('}))', start))
    expect(snapshot).toContain('consumeRelayCellRowLockScope(database)')
  })

  // Why: a field name is the contract between the emitter and Cloud Monitoring,
  // and a typo on either side yields no metric and no failure anywhere. That is
  // how cellInventoryHold* shipped log-only and unalertable for weeks.
  it('declares every counter as a Terraform log metric field', () => {
    const declared = declaredFields()
    for (const name of counterNames) expect(declared).toContain(name)
  })

  // Why: an HCL object constructor silently keeps the last duplicate, and fmt,
  // validate and plan all report success. The count is the only assertion.
  it('declares each counter exactly once', () => {
    const declared = declaredFields()
    for (const name of counterNames) {
      expect(declared.filter((field) => field === name)).toHaveLength(1)
    }
  })
})
