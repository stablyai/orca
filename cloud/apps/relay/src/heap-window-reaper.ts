import { performance } from 'node:perf_hooks'
import type { RelayDatabase, SqlRow } from './database.js'

export type HeapWindowReapBudget = {
  // Pages one DELETE may visit, so its row locks and WAL stay a few hundred rows.
  pagesPerStatement: number
  // Pages one tick may visit while it finds nothing to delete.
  maxPagesPerTick: number
  // Rows one tick deletes before it stops; this is what paces a backlog over days.
  maxRowsPerTick: number
  budgetMs: number
}

// Why a TID range and not `WHERE <retention> LIMIT n`: these tables have no index on their
// retention column, so the planner answers LIMIT with a sequential scan from page 0 (production
// EXPLAIN, 2026-10-04). That scan gets longer every tick as the reaped head of the heap empties.
// A TID range bounds each statement to its own pages whatever the table holds.
export class HeapWindowReaper {
  private nextPage: number | undefined

  constructor(
    private readonly table: string,
    private readonly predicate: string,
    private readonly budget: HeapWindowReapBudget,
    private readonly random: () => number = Math.random,
    private readonly clock: () => number = () => performance.now()
  ) {}

  async reap(database: RelayDatabase, params: unknown[]): Promise<number> {
    if (database.dialect !== 'postgres') {
      return changes(
        await database.query(
          `DELETE FROM ${this.table} WHERE rowid IN (
             SELECT rowid FROM ${this.table} WHERE ${this.predicate}
             LIMIT ${this.budget.maxRowsPerTick}
           )`,
          params
        )
      )
    }
    const pages = await heapPages(database, this.table)
    if (pages === 0) return 0
    // A random first page: every director runs this sweep, and walks that all start at page 0
    // after a rollout would read the same pages in lockstep.
    let page = this.nextPage ?? Math.floor(this.random() * pages)
    const startedAt = this.clock()
    let scanned = 0
    let deleted = 0
    while (
      scanned < this.budget.maxPagesPerTick &&
      deleted < this.budget.maxRowsPerTick &&
      this.clock() - startedAt < this.budget.budgetMs
    ) {
      if (page >= pages) page = 0
      const end = Math.min(page + this.budget.pagesPerStatement, pages)
      // SKIP LOCKED: a row some request holds is left for a later pass rather than waited on.
      // `= ANY(ARRAY(...))`, not `IN (...)`: IN can plan as a hash join over a sequential scan of
      // the whole table; an array of TIDs is always a TID scan.
      deleted += changes(
        await database.query(
          `DELETE FROM ${this.table} WHERE ctid = ANY(ARRAY(
             SELECT ctid FROM ${this.table}
             WHERE ctid >= CAST(? AS tid) AND ctid < CAST(? AS tid) AND ${this.predicate}
             FOR UPDATE SKIP LOCKED
           ))`,
          [`(${page},0)`, `(${end},0)`, ...params]
        )
      )
      scanned += end - page
      page = end
    }
    this.nextPage = page
    return deleted
  }
}

async function heapPages(database: RelayDatabase, table: string): Promise<number> {
  const row = (
    await database.query(
      `SELECT pg_relation_size(CAST(? AS regclass)) / current_setting('block_size')::bigint
         AS pages`,
      [table]
    )
  )[0]
  return Number(row?.pages ?? 0)
}

function changes(rows: SqlRow[]): number {
  return Number(rows[0]?.changes ?? 0)
}
