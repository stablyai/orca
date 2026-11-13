// KEK rotation sweep: moves every envelope-encrypted row from a retired KEK to the active one, so
// the retired KEK can be dropped from SECRETS_KEK_RETIRED. Operator routes (operator.ts):
//   GET  /v1/internal/secrets/kek      -> which KEK ids rows still reference, and which retired ids are droppable
//   POST /v1/internal/secrets/rewrap   {limit?, cursor?, dryRun?} -> one batch; repeat with `cursor` until `done`
// Idempotent and resumable: a batch selects only rows that are not current, so a run that stops
// anywhere is continued by calling again (with or without the cursor). Each write is conditional on
// the row still holding the bytes that were read, so a secret saved mid-sweep is never overwritten.
// v2 rows have only their DEK re-wrapped; v1 rows are decrypted and sealed again inside the keyring.
// Logs and responses carry counts, table names and KEK ids only: never a value, a key or ciphertext.
import type { CredentialAgent } from './agent-credential-names'
import { credentialBinding } from './agent-credentials'
import { githubUserTokenBinding } from './github-user-tokens'
import type { Keyring, SecretBinding } from './secrets-crypto'

type Sealed = { kek_id: string; wrapped_dek: string; ciphertext: string }
type Row = Sealed & Record<string, string>

type SealedTable = {
  table: string
  /** Primary-key columns (all TEXT), in key order. */
  key: readonly string[]
  /** The AAD identity the row was sealed under. */
  binding(row: Record<string, string>): SecretBinding
}

/**
 * Every table that stores a KEK-wrapped DEK. A table missing here would keep referencing a retired
 * KEK after a sweep reports done; test/secrets-rewrap.test.ts checks this list against the schema.
 */
export const SEALED_TABLES: readonly SealedTable[] = [
  { table: 'secrets', key: ['scope', 'owner_id', 'name'], binding: (row) => ({ scope: row.scope!, ownerId: row.owner_id!, name: row.name! }) },
  { table: 'agent_credentials', key: ['user_id', 'agent'], binding: (row) => credentialBinding(row.user_id!, row.agent as CredentialAgent) },
  { table: 'github_user_tokens', key: ['account_id', 'user_id'], binding: (row) => githubUserTokenBinding({ account_id: row.account_id!, user_id: row.user_id! }) }
]

export const REWRAP_DEFAULT_LIMIT = 200
export const REWRAP_MAX_LIMIT = 1000
const WRITE_CHUNK = 50

/** Rows a sweep still has to move: under another KEK, or v1 while the seal format is v2. */
function pendingWhere(keyring: Keyring): string {
  return keyring.sealFormat === 'v2' ? `(kek_id != ? OR wrapped_dek NOT LIKE 'v2.%')` : '(kek_id != ?)'
}

type Cursor = { table: number; after: string[] | null }

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.table, cursor.after]))
}

/** null for anything that is not a cursor this module produced. */
function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(value))
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return null
    }
    const [table, after] = parsed as [unknown, unknown]
    const spec = typeof table === 'number' ? SEALED_TABLES[table] : undefined
    if (!spec) {
      return null
    }
    if (after === null) {
      return { table: table as number, after: null }
    }
    if (!Array.isArray(after) || after.length !== spec.key.length || !after.every((part) => typeof part === 'string')) {
      return null
    }
    return { table: table as number, after: after as string[] }
  } catch {
    return null
  }
}

export type RewrapFailure = { table: string; kekId: string; reason: 'unknown_kek' | 'unreadable'; rows: number }

export type RewrapResult = {
  dryRun: boolean
  /** Rows read this batch. */
  scanned: number
  /** v2 rows whose DEK was re-wrapped; the value was not decrypted. */
  rewrapped: number
  /** v1 rows decrypted and sealed again under the active KEK. */
  resealed: number
  /** Rows that changed between the read and the write (someone saved them); they are current now or picked up next run. */
  raced: number
  /** Rows this keyring cannot open. They stay as they are and keep their KEK id in use. */
  failed: number
  failures: RewrapFailure[]
  /** Pass back to continue; null once every table has been walked. */
  cursor: string | null
  done: boolean
  /** Rows still not current after this batch (0 means every retired KEK is unreferenced). */
  pending: number
}

export class RewrapError extends Error {
  constructor(readonly reason: 'invalid_cursor' | 'invalid_limit') {
    super(reason)
    this.name = 'RewrapError'
  }
}

async function pendingCount(db: D1Database, keyring: Keyring): Promise<number> {
  let pending = 0
  for (const spec of SEALED_TABLES) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${pendingWhere(keyring)}`)
      .bind(keyring.activeId)
      .first<{ n: number }>()
    pending += row?.n ?? 0
  }
  return pending
}

/** One batch of the sweep. Call again with the returned cursor until `done`. */
export async function rewrapBatch(
  db: D1Database,
  keyring: Keyring,
  options: { limit?: number; cursor?: string | null; dryRun?: boolean } = {}
): Promise<RewrapResult> {
  const limit = options.limit ?? REWRAP_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > REWRAP_MAX_LIMIT) {
    throw new RewrapError('invalid_limit')
  }
  let position: Cursor = { table: 0, after: null }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor)
    if (!decoded) {
      throw new RewrapError('invalid_cursor')
    }
    position = decoded
  }
  const dryRun = options.dryRun === true
  const result = { scanned: 0, rewrapped: 0, resealed: 0, raced: 0, failed: 0 }
  const failures = new Map<string, RewrapFailure>()
  let done = false

  while (result.scanned < limit) {
    const spec = SEALED_TABLES[position.table]
    if (!spec) {
      done = true
      break
    }
    const columns = spec.key.join(', ')
    const afterKey = position.after ? ` AND (${columns}) > (${spec.key.map(() => '?').join(', ')})` : ''
    const take = limit - result.scanned
    const { results: rows } = await db
      .prepare(
        `SELECT ${columns}, kek_id, wrapped_dek, ciphertext FROM ${spec.table}
         WHERE ${pendingWhere(keyring)}${afterKey} ORDER BY ${columns} LIMIT ?`
      )
      .bind(keyring.activeId, ...(position.after ?? []), take)
      .all<Row>()

    const writes: { statement: D1PreparedStatement; mode: 'rewrapped' | 'resealed' }[] = []
    for (const row of rows) {
      result.scanned++
      const before = { kekId: row.kek_id, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext }
      let moved: Awaited<ReturnType<Keyring['rewrap']>>
      try {
        moved = await keyring.rewrap(spec.binding(row), before)
      } catch (error) {
        // The error text is one of this module's own fixed messages or a WebCrypto OperationError; it
        // is classified, never logged or returned.
        const reason = error instanceof Error && error.message === 'unknown KEK id' ? 'unknown_kek' : 'unreadable'
        const id = `${spec.table}\n${row.kek_id}\n${reason}`
        const entry = failures.get(id) ?? { table: spec.table, kekId: row.kek_id, reason, rows: 0 }
        entry.rows++
        failures.set(id, entry)
        result.failed++
        continue
      }
      if (!moved) {
        continue
      }
      if (dryRun) {
        result[moved.mode]++
        continue
      }
      writes.push({
        mode: moved.mode,
        // Conditional on the bytes that were read: a concurrent save (always under the active KEK) wins.
        statement: db
          .prepare(
            `UPDATE ${spec.table} SET kek_id = ?, wrapped_dek = ?, ciphertext = ?
             WHERE ${spec.key.map((column) => `${column} = ?`).join(' AND ')} AND kek_id = ? AND wrapped_dek = ? AND ciphertext = ?`
          )
          .bind(
            moved.sealed.kekId,
            moved.sealed.wrappedDek,
            moved.sealed.ciphertext,
            ...spec.key.map((column) => row[column]!),
            before.kekId,
            before.wrappedDek,
            before.ciphertext
          )
      })
    }
    for (let at = 0; at < writes.length; at += WRITE_CHUNK) {
      const chunk = writes.slice(at, at + WRITE_CHUNK)
      const outcomes = await db.batch(chunk.map((write) => write.statement))
      outcomes.forEach((outcome, index) => {
        if (outcome.meta.changes === 1) {
          result[chunk[index]!.mode]++
        } else {
          result.raced++
        }
      })
    }

    const last = rows.at(-1)
    position =
      rows.length < take || !last
        ? { table: position.table + 1, after: null }
        : { table: position.table, after: spec.key.map((column) => last[column]!) }
  }
  if (!SEALED_TABLES[position.table]) {
    done = true
  }

  const summary: RewrapResult = {
    dryRun,
    ...result,
    failures: [...failures.values()],
    cursor: done ? null : encodeCursor(position),
    done,
    pending: await pendingCount(db, keyring)
  }
  console.log(
    JSON.stringify({
      event: 'secrets_rewrap',
      activeKekId: keyring.activeId,
      sealFormat: keyring.sealFormat,
      dryRun,
      scanned: summary.scanned,
      rewrapped: summary.rewrapped,
      resealed: summary.resealed,
      raced: summary.raced,
      failed: summary.failed,
      failures: summary.failures,
      pending: summary.pending,
      done
    })
  )
  return summary
}

export type KekStatus = {
  activeKekId: string
  sealFormat: 'v1' | 'v2'
  /** Retired KEK ids this Worker is configured with. */
  retiredKekIds: string[]
  /** Per table, per KEK id: rows and how many of them are still v1. */
  tables: Record<string, Record<string, { rows: number; v1: number }>>
  /** Rows a sweep would still move. */
  pending: number
  /** Retired ids rows still reference: keep them configured. */
  retiredInUse: string[]
  /** Retired ids no row references: safe to remove from SECRETS_KEK_RETIRED. */
  retiredDroppable: string[]
  /** KEK ids rows reference that this Worker has no key for: those rows cannot be opened. */
  unknownKekIds: string[]
}

/** What rows reference which KEK. Ids and counts only. */
export async function kekStatus(db: D1Database, keyring: Keyring): Promise<KekStatus> {
  const tables: KekStatus['tables'] = {}
  const referenced = new Set<string>()
  for (const spec of SEALED_TABLES) {
    const { results } = await db
      .prepare(
        `SELECT kek_id, COUNT(*) AS n, SUM(CASE WHEN wrapped_dek LIKE 'v2.%' THEN 0 ELSE 1 END) AS v1
         FROM ${spec.table} GROUP BY kek_id ORDER BY kek_id`
      )
      .all<{ kek_id: string; n: number; v1: number }>()
    tables[spec.table] = Object.fromEntries(results.map((row) => [row.kek_id, { rows: row.n, v1: row.v1 }]))
    for (const row of results) {
      referenced.add(row.kek_id)
    }
  }
  const known = new Set([keyring.activeId, ...keyring.retiredIds])
  return {
    activeKekId: keyring.activeId,
    sealFormat: keyring.sealFormat,
    retiredKekIds: keyring.retiredIds,
    tables,
    pending: await pendingCount(db, keyring),
    retiredInUse: keyring.retiredIds.filter((id) => referenced.has(id)),
    retiredDroppable: keyring.retiredIds.filter((id) => !referenced.has(id)),
    unknownKekIds: [...referenced].filter((id) => !known.has(id)).sort()
  }
}
