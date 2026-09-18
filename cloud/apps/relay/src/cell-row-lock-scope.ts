import type { SqlRow } from './database.js'

// A transaction may WAIT for a relay_cells row lock only in ascending cell_id,
// and re-touching a row it already holds is free. That is what stops cross-cell
// cycles, and nothing checked it: per-statement sorting is not enough, because
// one transaction taking {A} then {B} while another takes {B} then {A} is two
// trivially sorted statements and one deadlock. This is a SQL-shape assertion --
// which cell_ids does the statement name, against what the transaction holds --
// so it reads the same on Postgres and on SQLite, and ordinary tests prove it.

// Waiting is what the order governs. A NOWAIT acquisition either takes the row
// at once or fails, so it is never an edge in a wait-for cycle and its position
// in the order cannot matter; it is still recorded, because a later wait must be
// ordered against everything the transaction holds however it got there.
export type CellRowLockKind = 'none' | 'wait' | 'nowait'

type CellRowLockViolation = {
  reason: 'out-of-order' | 'unordered-lock' | 'unparsed-write'
  cellIds: string[]
  held: string[]
  statement: string
}

export type CellRowLockScopeOutcome = {
  checked: boolean
  stoodDown: boolean
  violated: boolean
}

export function emptyCellRowLockScopeOutcome(): CellRowLockScopeOutcome {
  return { checked: false, stoodDown: false, violated: false }
}

// Merged across a transaction's attempts, so the counters describe transactions
// rather than attempts: a retry replays the same statements, and counting each
// one made a single logical transaction report up to three times -- inflation
// worst under exactly the contention these numbers exist to measure.
//
// `violated` is any-of, not a sum and not a max. Summing rises with contention
// rather than with breakage; a max cannot inflate but can still ZERO OUT an
// observed violation, because an attempt that violates and then hits a retryable
// 55P03 can be followed by a clean attempt that takes a different branch. The
// gate here is zero-versus-nonzero, so what has to survive is "this transaction
// violated at least once". Magnitude lives in the distinct-signature log.
export function mergeCellRowLockScopeOutcomes(
  left: CellRowLockScopeOutcome,
  right: CellRowLockScopeOutcome
): CellRowLockScopeOutcome {
  return {
    checked: left.checked || right.checked,
    stoodDown: left.stoodDown || right.stoodDown,
    violated: left.violated || right.violated
  }
}

// Why: `violations === 0` is only evidence if something was examined. Checked
// counts transactions where at least one cell row lock was evaluated, which is
// the population a per-cell conversion moves; stoodDown counts the ones holding a
// statement this guard could not read, and must be a bug report, not a clean run.
// Violations counts violating TRANSACTIONS, not violating statements.
export type CellRowLockScopeCounts = {
  cellRowLockScopesChecked: number
  cellRowLockScopesStoodDown: number
  cellRowLockScopeViolations: number
}

export function emptyCellRowLockScopeCounts(): CellRowLockScopeCounts {
  return {
    cellRowLockScopesChecked: 0,
    cellRowLockScopesStoodDown: 0,
    cellRowLockScopeViolations: 0
  }
}

export class CellRowLockScopeSamples {
  private counts = emptyCellRowLockScopeCounts()

  record(outcome: CellRowLockScopeOutcome): void {
    if (outcome.checked) this.counts.cellRowLockScopesChecked += 1
    if (outcome.stoodDown) this.counts.cellRowLockScopesStoodDown += 1
    if (outcome.violated) this.counts.cellRowLockScopeViolations += 1
  }

  consumeCounts(): CellRowLockScopeCounts {
    const counts = this.counts
    this.counts = emptyCellRowLockScopeCounts()
    return counts
  }
}

// Every statement runs through observe(), so the pre-filter is a substring test
// rather than a regex. Case-sensitive, like the census that ratchets these sites.
const CELL_TABLE = 'relay_cells'
const CELL_INSERT = /^\s*INSERT\s+INTO\s+relay_cells\s*\(([^)]*)\)\s*VALUES\s*\(/i
// Any insert into the table, matched separately so a shape the parser above does
// not recognise -- INSERT ... SELECT, a multi-row VALUES -- is reported rather
// than silently skipped. Silence is what this guard sells; a shape that falls
// through every branch is the one failure it must never have.
const CELL_INSERT_ANY = /^\s*INSERT\s+INTO\s+relay_cells\b/i
// A second VALUES tuple. insertedCellIds reads only the first, so the rest would
// be missing from `held` -- and a missing entry on the insert path is the one
// direction that invents a report instead of losing one.
const MULTI_ROW_VALUES = /\)\s*,\s*\(/
const CELL_ROW_WRITE = /^\s*(?:UPDATE|DELETE\s+FROM)\s+relay_cells\b/i
// The statement's own relation, not any mention of the table: relay_assignments,
// relay_cell_runtime and relay_migrations all carry a cell_id that would
// otherwise be recorded as a held cell row. The narrow reading is deliberate and
// it under-reports in two known ways, both of which only ever cost a report and
// never invent one: a locked read of another table that JOINs relay_cells does
// lock cell rows, because Postgres FOR UPDATE without OF locks every table in the
// FROM list; and a WITH ... SELECT does not match the SELECT anchor at all.
// Neither shape exists in relay today.
const CELL_TABLE_READ = /^\s*SELECT\b[\s\S]*?\bFROM\s+([A-Za-z_]\w*)/i
const CELL_ID_EQUALS = /\bcell_id\s*=\s*\?/gi
// Any predicate that bounds which cell rows a locked read can reach. A statement
// with none of these and no ORDER BY takes the whole table in plan order.
const CONSTRAINS_CELL = /\bcell_id\s*(?:=|\bIN\b|\bANY\b)/i
// Alias-tolerant: `ORDER BY cell.cell_id ASC` orders identically, and rejecting
// it would throw in tests on a statement that is correct.
const ORDERED_LOCK = /\bORDER\s+BY\s+(?:\w+\.)?cell_id\s+ASC\b/i
// KNOWN GAP, and it blocks the conversion rather than this deploy.
// `INSERT ... ON CONFLICT DO UPDATE` that COLLIDES takes the existing row's lock
// and blocks -- measured at 3073ms against PostgreSQL 16, and the obvious
// interleaving deadlocks -- so a collision is a waiting acquisition that belongs
// under the order check. An upsert that CREATES is free, because nobody can hold
// a row that does not exist. The statement text cannot tell them apart.
//
// Inferring it from "the transaction already took a fleet-wide lock" was tried
// and is wrong twice over: that lock does not fence rows another transaction
// creates after it (demonstrated deadlock), and over an empty inventory it locks
// nothing at all while still looking like total cover (demonstrated deadlock at
// bootstrap). Worse, the predicate could not tell a one-row `cell_id IN (?)
// ORDER BY cell_id ASC` from the fleet lock -- so the per-cell conversion this
// guard exists to police would have re-armed the exemption and silenced it.
//
// So an upsert stays set-extension for now and this stays a hole. Closing it
// needs the create-versus-collide distinction made explicit -- a flag threaded
// from the three registration call sites, or `RETURNING (xmax = 0)`, which works
// only on Postgres and would cost the both-dialects property. That belongs with
// the conversion, which is where the hazard actually becomes reachable.

export class CellRowLockScope {
  private readonly held = new Set<string>()
  // A statement the scope could not read -- a locked read whose rows do not name
  // their cell, or one that threw while being parsed. Scoped to the statement,
  // not the transaction: skipping it and carrying on is strictly safer than
  // muting everything after it, because the only effect of a missing `held` entry
  // is to REMOVE reports, never to invent one. A transaction-wide latch turned a
  // single unreadable projection into a silent transaction.
  private stoodDown = false
  private checked = false
  private violated = false

  // Why the wrapper: this runs inside the caller's try, so anything thrown here
  // escapes as that statement's failure and is mislabelled with its SQL phase on
  // the way out. A warn-only observer must be structurally unable to fail a
  // request, not merely unable in the shapes reachable today.
  observe(sql: string, params: readonly unknown[], lock: CellRowLockKind, rows: SqlRow[]): void {
    try {
      this.inspect(sql, params, lock, rows)
    } catch (error) {
      if (error instanceof CellRowLockScopeViolationError) throw error
      this.noteStandDown(`unreadable:${fingerprint(sql)}`)
    }
  }

  private inspect(
    sql: string,
    params: readonly unknown[],
    lock: CellRowLockKind,
    rows: SqlRow[]
  ): void {
    if (!sql.includes(CELL_TABLE)) return
    if (CELL_INSERT.test(sql)) {
      // See the CELL_UPSERT note above: a colliding upsert is a waiting
      // acquisition this does not police, and closing that needs the conversion.
      const inserted = insertedCellIds(sql, params)
      // A recognised shape that yielded no cell_id, or a second VALUES tuple this
      // parser does not read, would otherwise leave rows out of `held` -- which
      // turns into a FALSE out-of-order report on the next write naming them.
      if (inserted.length === 0 || MULTI_ROW_VALUES.test(sql)) {
        this.noteStandDown(fingerprint(sql))
        return
      }
      for (const cellId of inserted) this.held.add(cellId)
      return
    }
    if (CELL_INSERT_ANY.test(sql)) {
      // Reached only by an insert shape the parser above does not read.
      this.note()
      this.acquire(undefined, fingerprint(sql), 'wait')
      return
    }
    if (CELL_ROW_WRITE.test(sql)) {
      // A write blocks on a conflicting row lock, so it is always a wait. This is
      // how the release and acquire paths take one row late, and what bounds it.
      this.note()
      this.acquire(namedCellIds(sql, params), fingerprint(sql), 'wait')
      return
    }
    if (lock !== 'none' && CELL_TABLE_READ.exec(sql)?.[1] === CELL_TABLE) {
      this.acquireRead(sql, lock, rows)
    }
  }

  // Why: a guard that reports nothing is indistinguishable from a guard that was
  // never reached or quietly stood down, and the deploy plan is to trust its
  // silence. These give the silence a denominator.
  outcome(): CellRowLockScopeOutcome {
    return { checked: this.checked, stoodDown: this.stoodDown, violated: this.violated }
  }

  // Why reads count too: `checked` is the denominator for "the guard saw the
  // population a per-cell conversion moves", and that population is every
  // transaction that acquires a cell row lock. Counting only writes missed 44% of
  // them when measured across this suite -- including the fleet-wide
  // `SELECT ... FOR UPDATE` the conversion exists to replace, which scored zero.
  private note(): void {
    this.checked = true
  }

  // Statement-scoped, and always visible: silence that reads the same as a clean
  // transaction is the failure this guard exists to avoid.
  private noteStandDown(statement: string): void {
    this.stoodDown = true
    reportStandDown(statement)
  }

  private acquireRead(sql: string, lock: CellRowLockKind, rows: SqlRow[]): void {
    const statement = fingerprint(sql)
    // Shape, not row count: a lock naming no cell at all may return one row in a
    // fixture and the whole table in production, so judging it by what came back
    // makes the ratchet depend on the seed data. Deliberately conservative -- it
    // asks only whether the statement constrains cell_id somehow, because a
    // cleverer predicate produced FALSE reports on correct SQL, and those throw
    // in tests. Under-reporting costs a catch; over-reporting costs trust.
    if (!ORDERED_LOCK.test(sql) && !CONSTRAINS_CELL.test(sql)) {
      this.report({ reason: 'unordered-lock', cellIds: [], held: [...this.held], statement })
    }
    const cellIds: string[] = []
    for (const row of rows) {
      const cellId = row.cell_id
      if (typeof cellId !== 'string') {
        // Skip this read only. Its rows never enter `held`, which can only cost
        // a later report, never manufacture one.
        this.noteStandDown(statement)
        return
      }
      cellIds.push(cellId)
    }
    // Counted here and not on entry: a read that stands down was not judged, and
    // counting it would put transactions the guard declined to reason about into
    // the denominator that says how many it did.
    this.note()
    this.acquire(cellIds, statement, lock)
  }

  // Counted before it is thrown: in production report() only warns, so the count
  // is what carries the magnitude the once-per-signature log deliberately drops.
  private report(violation: CellRowLockViolation): void {
    this.violated = true
    report(violation)
  }

  private acquire(
    cellIds: string[] | undefined,
    statement: string,
    lock: CellRowLockKind
  ): void {
    if (cellIds === undefined) {
      this.report({ reason: 'unparsed-write', cellIds: [], held: [...this.held], statement })
      return
    }
    for (const cellId of cellIds) {
      if (this.held.has(cellId)) continue
      const below =
        lock === 'nowait' ? [] : [...this.held].filter((held) => sortsBelow(cellId, held))
      if (below.length > 0) {
        this.report({ reason: 'out-of-order', cellIds: [cellId], held: below, statement })
      }
      this.held.add(cellId)
    }
  }
}

// Why both comparisons: ORDER BY uses the column's collation, which on a
// linguistic locale treats punctuation as secondary, while JS compares code
// units. Reporting only where the two agree keeps a collation difference from
// inventing a violation in the one signal this guard exists to keep clean.
function sortsBelow(candidate: string, held: string): boolean {
  return candidate < held && alphanumeric(candidate) < alphanumeric(held)
}

function alphanumeric(cellId: string): string {
  return cellId.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Positional binding: the nth `?` takes the nth parameter. A `?` inside a string
// literal would shift this, and no relay statement has one.
function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length
}

function namedCellIds(sql: string, params: readonly unknown[]): string[] | undefined {
  const cellIds: string[] = []
  for (const match of sql.matchAll(CELL_ID_EQUALS)) {
    const value = params[placeholderCount(sql.slice(0, match.index))]
    if (typeof value !== 'string') return undefined
    cellIds.push(value)
  }
  // A write that names no single cell reaches rows the scope cannot bound, so it
  // is reported rather than waved through.
  return cellIds.length > 0 ? cellIds : undefined
}

function insertedCellIds(sql: string, params: readonly unknown[]): string[] {
  const match = CELL_INSERT.exec(sql)
  if (!match) return []
  const column = match[1]!.split(',').findIndex((name) => name.trim() === 'cell_id')
  if (column < 0) return []
  const head = sql.slice(0, match.index + match[0].length)
  const tuple = sql.slice(head.length, sql.indexOf(')', head.length)).split(',')
  if (tuple[column]?.trim() !== '?') return []
  const before = tuple.slice(0, column).filter((value) => value.trim() === '?').length
  const cellId = params[placeholderCount(head) + before]
  return typeof cellId === 'string' ? [cellId] : []
}

// Bounded by the number of call sites: relay SQL is static per site, so the
// reported-once set below cannot grow with traffic.
function fingerprint(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 80)
}

const reported = new Set<string>()

// Never throws: standing down is not a failed invariant, it is the guard
// declining to judge a shape it cannot read. It still has to be visible, or the
// counters would be the only trace and a silent scope would look like a clean one.
function reportStandDown(statement: string): void {
  const signature = `stood-down:${statement}`
  if (reported.has(signature)) return
  reported.add(signature)
  console.warn(
    JSON.stringify({ event: 'orca_relay_cell_row_lock_scope_stood_down', statement })
  )
}

// Deliberately not a throw in production. This guard ships ahead of the per-cell
// locking conversions it exists to police, so its first job is to be observed
// firing nowhere -- taking the fleet down to prove a hypothesis is the wrong
// trade. Tests throw, so a real violation still cannot land green.
// Distinct from an unreadable statement so observe()'s catch can tell a real
// violation apart from the guard's own failure and rethrow only the former.
export class CellRowLockScopeViolationError extends Error {}

function report(violation: CellRowLockViolation): void {
  if (process.env.NODE_ENV === 'test') {
    throw new CellRowLockScopeViolationError(
      `cell_row_lock_scope_violation ${violation.reason}` +
        ` cells=[${violation.cellIds.join(', ')}]` +
        ` held=[${violation.held.join(', ')}] sql=${violation.statement}`
    )
  }
  const signature = `${violation.reason}:${violation.statement}`
  if (reported.has(signature)) return
  reported.add(signature)
  console.warn(
    JSON.stringify({ event: 'orca_relay_cell_row_lock_scope_violation', ...violation })
  )
}
