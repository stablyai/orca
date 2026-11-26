// One batched fingerprint of the rows a finished worker's read rests on, so a kept read is checked in
// one query instead of walked again.
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  DISPATCH_CONTEXT_COLUMNS,
  TASK_COLUMNS,
  WORKER_DISPATCH_COLUMNS,
  WORKER_TERMINAL_RESOURCE_COLUMNS
} from '../runtime/orchestration/db/row-column-lists'

/** A worker's newest Dispatch and its resource. */
type PrintedRows = { dispatchId: string; resourceId: string | null }

/** Text that can be long counts by its length and ends; every other column by its value. */
const LONG_COLUMNS = new Set([
  'last_failure',
  'origin_ref',
  'chat_lineage',
  'effects',
  'residual_resources',
  'start_options',
  'last_error',
  'prior_owner_dispatch_ids',
  'resume_session',
  'spec',
  'result'
])

function rowPrint(alias: string, columns: readonly string[]): string {
  return columns
    .map((column) => {
      const value = `${alias}.${column}`
      return LONG_COLUMNS.has(column)
        ? `ifnull(length(${value}) || substr(${value}, 1, 24) || substr(${value}, -24), '~')`
        : `ifnull(${value}, '~')`
    })
    .join(' || char(31) || ')
}

// Every row a finished worker's read rests on: its newest Dispatch, worker, resource and Task, any
// resource it now owns, a follow-up that continues it, and a paired-server record of it.
const PRINT_SQL = `SELECT j.key AS i,
  (SELECT ${rowPrint('d', DISPATCH_CONTEXT_COLUMNS)} FROM dispatch_contexts d WHERE d.id = json_extract(j.value, '$.d'))
  || char(30) || ifnull((SELECT ${rowPrint('w', WORKER_DISPATCH_COLUMNS)} FROM worker_dispatches w WHERE w.dispatch_id = json_extract(j.value, '$.d')), '-')
  || char(30) || ifnull((SELECT ${rowPrint('r', WORKER_TERMINAL_RESOURCE_COLUMNS)} FROM worker_terminal_resources r WHERE r.id = json_extract(j.value, '$.r')), '-')
  || char(30) || ifnull((SELECT group_concat(o.id) FROM worker_terminal_resources o WHERE o.owner_dispatch_id = json_extract(j.value, '$.d')), '-')
  || char(30) || ifnull((SELECT ${rowPrint('t', TASK_COLUMNS)} FROM dispatch_contexts td JOIN tasks t ON t.id = td.task_id WHERE td.id = json_extract(j.value, '$.d')), '-')
  || char(30) || EXISTS(SELECT 1 FROM dispatch_contexts f WHERE f.follow_up_of_dispatch_id = json_extract(j.value, '$.d'))
  || char(30) || EXISTS(SELECT 1 FROM federated_dispatches fd WHERE fd.dispatch_id = json_extract(j.value, '$.d')) AS print,
  (SELECT reason FROM worker_dock_facts WHERE dispatch_id = json_extract(j.value, '$.d')) AS reason
  FROM json_each(?) j`

export function printKey(kept: PrintedRows): string {
  return `${kept.dispatchId}\0${kept.resourceId ?? ''}`
}

/** Each kept worker's rows as one number, and its stop reason, in one read; a missing row reads as none. */
export function readPrints(
  db: OrchestrationDb,
  kept: readonly PrintedRows[]
): Map<string, { print: number; reason: string | null }> {
  const keys = [...new Set(kept.map(printKey))]
  if (keys.length === 0) {
    return new Map()
  }
  const asked = keys.map((key) => {
    const [d, r] = key.split('\0')
    return { d, r: r || null }
  })
  try {
    const rows = db.db.prepare(PRINT_SQL).all(JSON.stringify(asked))
    const prints = new Map<string, { print: number; reason: string | null }>()
    for (const row of rows) {
      if (typeof row.print === 'string') {
        prints.set(keys[Number(row.i)], {
          print: hashText(row.print),
          reason: typeof row.reason === 'string' ? row.reason : null
        })
      }
    }
    return prints
  } catch {
    return new Map()
  }
}

/** A 53-bit string hash (cyrb53): a fingerprint compares as one number, not the text it came from. */
function hashText(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** The dock facts' revision, which every change to them bumps; null when unreadable. */
export function dockRevision(db: OrchestrationDb): number | null {
  try {
    const row = db.db.prepare('SELECT revision FROM worker_dock_revision WHERE id = 1').get()
    return typeof row?.revision === 'number' ? row.revision : null
  } catch {
    return null
  }
}

/** SQLite's count of commits other connections made to this database; null when unreadable. */
export function dataVersion(db: OrchestrationDb): number | null {
  try {
    const row = db.db.prepare('PRAGMA data_version').get()
    return typeof row?.data_version === 'number' ? row.data_version : null
  } catch {
    return null
  }
}
