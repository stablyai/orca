import { deserialize, serialize } from 'node:v8'
import type { SqliteStatement, SqliteBindings } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  directJournalColumns,
  type DirectJournalRecord
} from './journal-sql-direct-values.test-fixture'

/** In-process transport experiment: exactly one serialized chunk outstanding until its commit. */
export async function stageDirectJournalRecords(
  scope: JournalSqlScope,
  records: Iterable<DirectJournalRecord>,
  options: { maxRows?: number; maxBytes?: number; acknowledge?: () => Promise<void> } = {}
) {
  const statements = new Map<string, SqliteStatement>()
  const work = {
    rows: 0,
    bytes: 0,
    chunks: 0,
    maxChunkBytes: 0,
    oversized: 0,
    serializationMs: 0,
    deserializationMs: 0,
    insertsMs: 0,
    commitsMs: 0,
    totalMs: 0,
    encodingMs: 0,
    families: new Map<string, { rows: number; bytes: number; insertsMs: number }>()
  }
  const started = performance.now()
  const initialMemory = process.memoryUsage()
  const peakMemory = {
    rss: initialMemory.rss,
    heapUsed: initialMemory.heapUsed,
    external: initialMemory.external
  }
  let chunk: DirectJournalRecord[] = []
  let estimatedBytes = 0
  const maxRows = options.maxRows ?? 256
  const maxBytes = options.maxBytes ?? 1024 * 1024
  if (maxRows < 1 || maxBytes < 1) {
    throw new Error('Invalid direct journal chunk bound')
  }
  const send = async () => {
    if (chunk.length === 0) {
      return
    }
    const before = performance.now()
    const wire = serialize(chunk)
    work.serializationMs += performance.now() - before
    work.bytes += wire.byteLength
    work.maxChunkBytes = Math.max(work.maxChunkBytes, wire.byteLength)
    work.chunks++
    if (wire.byteLength > maxBytes) {
      if (chunk.length !== 1) {
        throw new Error('Direct journal chunk exceeds its bound')
      }
      work.oversized++
    }
    const decodeStarted = performance.now()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this scoped sink decodes only the typed chunk serialized immediately above.
    const decoded = deserialize(wire) as DirectJournalRecord[]
    work.deserializationMs += performance.now() - decodeStarted
    const insertStarted = performance.now()
    scope.db.exec('BEGIN IMMEDIATE')
    try {
      const groups = new Map<DirectJournalRecord['table'], DirectJournalRecord[]>()
      for (const record of decoded) {
        const group = groups.get(record.table) ?? []
        group.push(record)
        groups.set(record.table, group)
      }
      for (const [table, group] of groups) {
        const family = work.families.get(table) ?? { rows: 0, bytes: 0, insertsMs: 0 }
        const familyStarted = performance.now()
        const width = group[0].values.length + 2
        const bound = Math.max(1, Math.floor(30000 / width))
        for (let offset = 0; offset < group.length; offset += bound) {
          const batch = group.slice(offset, offset + bound)
          const cacheKey = `${table}:${batch.length}`
          let statement = statements.get(cacheKey)
          if (!statement) {
            const columns = directJournalColumns[table]
            const row = `(${Array.from({ length: width }, () => '?').join(',')})`
            statement = scope.db
              .prepare(`INSERT ${table === 'value_refs' ? 'OR IGNORE ' : ''}INTO journal_proj_${table}
              (session_id,generation,${columns}) VALUES ${batch.map(() => row).join(',')}`)
            statements.set(cacheKey, statement)
          }
          const parameters: SqliteBindings = []
          for (const record of batch) {
            parameters.push(...scope.prefix, ...record.values)
          }
          statement.run(...parameters)
        }
        family.insertsMs += performance.now() - familyStarted
        family.rows += group.length
        for (const record of group) {
          family.bytes += record.values.reduce<number>(
            (bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : 8),
            0
          )
        }
        work.families.set(table, family)
        work.rows += group.length
      }
      work.insertsMs += performance.now() - insertStarted
      const commitStarted = performance.now()
      scope.db.exec('COMMIT')
      work.commitsMs += performance.now() - commitStarted
    } catch (error) {
      scope.db.exec('ROLLBACK')
      throw error
    }
    chunk = []
    estimatedBytes = 0
    const memory = process.memoryUsage()
    for (const key of ['rss', 'heapUsed', 'external'] as const) {
      peakMemory[key] = Math.max(peakMemory[key], memory[key])
    }
    await options.acknowledge?.()
  }
  for (const record of records) {
    const estimate =
      128 +
      record.values.reduce<number>(
        (bytes, value) => bytes + 16 + (typeof value === 'string' ? Buffer.byteLength(value) : 8),
        0
      )
    if (chunk.length > 0 && (chunk.length >= maxRows || estimatedBytes + estimate > maxBytes)) {
      await send()
    }
    chunk.push(record)
    estimatedBytes += estimate
  }
  await send()
  work.totalMs = performance.now() - started
  work.encodingMs =
    work.totalMs - work.serializationMs - work.deserializationMs - work.insertsMs - work.commitsMs
  return { ...work, statements: statements.size, initialMemory, peakMemory }
}
