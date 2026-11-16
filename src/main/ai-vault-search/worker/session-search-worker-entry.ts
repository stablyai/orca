import { SessionSearchToolPurge } from '../storage/session-search-tool-purge'
import { readIndexGeneration } from '../storage/session-search-index-generation'
import { parentPort } from 'node:worker_threads'
import SyncDatabase from '../../sqlite/sync-database'
import { withSpan, setActiveSink } from '../../observability/tracer'
import { SessionSearchStore } from '../storage/session-search-store'
import type { SessionSearchStateCounts } from '../storage/session-search-store-types'
import { SessionSearchEngine } from '../query/session-search-engine'
import { createSessionSearchService } from '../session-search-service'
import type { SessionSearchFileWrite } from '../storage/session-search-index-writer'
import type { TranscriptSessionIdentity } from '../../ai-vault/transcripts/session-transcript-consumers'
import type {
  SearchWorkerRequest,
  SearchWorkerResponse,
  SessionSearchSnapshotRow
} from './session-search-worker-protocol'

setActiveSink({
  push: (trace) => parentPort?.postMessage({ id: 0, trace }),
  flush() {},
  close() {}
})

let store: SessionSearchStore | null = null
let toolPurge: SessionSearchToolPurge | null = null
let reader: SyncDatabase | null = null
let engine: SessionSearchEngine | null = null
let dataVersion: unknown
let counts: SessionSearchStateCounts = {
  current: 0,
  due: 0,
  failed: 0,
  messages: 0,
  sessionsByAgent: {}
}
const files = new Map<string, SessionSearchSnapshotRow>()
const writes = new Map<
  number,
  { write: SessionSearchFileWrite; identity: TranscriptSessionIdentity | null }
>()

function rows(path?: string): SessionSearchSnapshotRow[] {
  if (!store) {
    return []
  }
  return store.connection
    .prepare(`SELECT f.path, CAST(f.dev AS REAL) AS dev, CAST(f.ino AS REAL) AS ino,
    f.mtime_ms, f.size_bytes, f.state, f.fail_count, f.failed_mtime_ms, f.byte_offset, f.prefix_hash,
    s.agent, s.content_hash, s.content_hash_count FROM files f LEFT JOIN sessions s ON s.id=f.session_row_id
    ${path === undefined ? '' : 'WHERE f.path = ?'}`)
    .all(...(path === undefined ? [] : [path]))
    .map((row) => ({
      path: String(row.path),
      identity:
        typeof row.dev === 'number' && typeof row.ino === 'number'
          ? { dev: row.dev, ino: row.ino }
          : null,
      mtimeMs: Number(row.mtime_ms),
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      state: row.state === 'due' ? 'due' : row.state === 'failed' ? 'failed' : 'current',
      failCount: Number(row.fail_count),
      failedMtimeMs: row.failed_mtime_ms === null ? null : Number(row.failed_mtime_ms),
      byteOffset: row.byte_offset === -1 ? null : Number(row.byte_offset),
      prefixHash: typeof row.prefix_hash === 'string' ? row.prefix_hash : null,
      agent: typeof row.agent === 'string' ? row.agent : null,
      contentHash: {
        hash: typeof row.content_hash === 'string' ? row.content_hash : null,
        count: Number(row.content_hash_count ?? 0)
      }
    }))
}
function snapshot(): SessionSearchSnapshotRow[] {
  if (!store) {
    return []
  }
  const db = store.connection
  const observed = db.pragma('data_version', { simple: true })
  db.exec('BEGIN')
  try {
    const snapshot = rows()
    counts = store.stateCounts()
    db.exec('COMMIT')
    files.clear()
    for (const row of snapshot) {
      files.set(row.path, row)
    }
    dataVersion = observed
    return snapshot
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function delta(path: string) {
  const previous = files.get(path)
  const row = rows(path)[0] ?? null
  if (previous) {
    counts[previous.state]--
    if (previous.agent) {
      counts.sessionsByAgent[previous.agent]--
    }
  }
  if (row) {
    counts[row.state]++
    if (row.agent) {
      counts.sessionsByAgent[row.agent] = (counts.sessionsByAgent[row.agent] ?? 0) + 1
    }
    files.set(path, row)
  } else {
    files.delete(path)
  }
  for (const agent of Object.keys(counts.sessionsByAgent)) {
    if (!counts.sessionsByAgent[agent]) {
      delete counts.sessionsByAgent[agent]
    }
  }
  return { path, row }
}
async function execute({ id, command: c }: SearchWorkerRequest): Promise<SearchWorkerResponse> {
  if (c.op === 'open') {
    if (c.reader) {
      reader = new SyncDatabase(c.path, { readonly: true, fileMustExist: true })
      engine = new SessionSearchEngine(reader, { retentionCutoffMs: c.cutoff })
      reader.pragma('query_only = ON')
      return { id }
    }
    const onMessagesChanged = (n: number): void => {
      counts.messages += n
      parentPort?.postMessage({
        id: 0,
        counts,
        generation: readIndexGeneration(store!.connection)
      })
    }
    const onError = (error: unknown): never => {
      throw error
    }
    store = new SessionSearchStore(c.path, onError, onMessagesChanged)
    // Why: worker retirement closes the connection and its maintenance together.
    toolPurge = new SessionSearchToolPurge(
      store.connection,
      () => false,
      onMessagesChanged,
      onError
    )
    void toolPurge.request()
    store.setRetentionCutoffMs(c.cutoff)
    return { id, snapshot: snapshot(), counts, generation: readIndexGeneration(store.connection) }
  }
  if (c.op === 'query') {
    if (!engine) {
      throw new Error('Search reader is not open')
    }
    const service = createSessionSearchService({
      engine,
      indexer: {
        status: () => {
          throw new Error('Reader has no indexer')
        },
        reconcile: async () => undefined
      }
    })
    return {
      id,
      result: await withSpan('aiVault.search.query', () => service.search(c.request, c.scope))
    }
  }
  if (!store) {
    throw new Error('Search writer is not open')
  }
  let reset: SessionSearchSnapshotRow[] | undefined
  // Why: SQLite data_version changes only for foreign commits, including legacy writers' generation bumps.
  if (dataVersion !== store.connection.pragma('data_version', { simple: true })) {
    for (const { write } of writes.values()) {
      write.discard()
    }
    writes.clear()
    handlePaths.clear()
    reset = snapshot()
    void toolPurge?.request()
  }
  let path: string | undefined
  let accepted = true
  switch (c.op) {
    case 'begin': {
      handlePaths.set(c.handle, c.candidate.file.path)
      let identity: TranscriptSessionIdentity | null = null
      const write = store.beginWrite(c.candidate, c.mode, c.offset, () => identity)
      if (write) {
        writes.set(c.handle, {
          write,
          get identity() {
            return identity
          },
          set identity(value) {
            identity = value
          }
        })
      }
      accepted = write !== null
      break
    }
    case 'batch': {
      const entry = writes.get(c.handle)
      accepted = !!entry
      if (entry) {
        entry.identity = c.identity
        entry.write.addPrepared!(c.rows, c.hash)
      }
      break
    }
    case 'finish': {
      const entry = writes.get(c.handle)
      entry?.write.addPrepared!([], c.hash)
      accepted = !!entry && entry.write.commit(c.outcome)
      writes.delete(c.handle)
      if (accepted) {
        const path = handlePaths.get(c.handle)
        if (path) {
          store.setFileState(path, 'current')
        }
      }
      break
    }
    case 'discard':
      writes.get(c.handle)?.write.discard()
      writes.delete(c.handle)
      break
    case 'state':
      store.setFileState(c.path, c.state, c.mtime)
      path = c.path
      break
    case 'remove':
      store.removeFile(c.path)
      path = c.path
      break
    case 'purge': {
      store.setRetentionCutoffMs(c.cutoff)
      const before = [...files.keys()]
      await withSpan('aiVault.search.retentionPurge', () => store!.purgeOlderThan(c.cutoff))
      const remaining = new Map(rows().map((row) => [row.path, row]))
      const deltas = before.filter((p) => !remaining.has(p)).map(delta)
      return {
        id,
        snapshot: reset,
        deltas,
        counts,
        generation: readIndexGeneration(store.connection)
      }
    }
    case 'sync':
      break
  }
  if (c.op === 'batch' || c.op === 'finish') {
    // A named chunk can commit before EOF; publish its partial cursor immediately.
    path = handlePaths.get(c.handle)
  }
  if (c.op === 'begin') {
    handlePaths.set(c.handle, c.candidate.file.path)
  }
  if (c.op === 'finish' || c.op === 'discard') {
    handlePaths.delete(c.handle)
  }
  return {
    id,
    accepted,
    snapshot: reset,
    deltas: path ? [delta(path)] : undefined,
    counts,
    generation: readIndexGeneration(store.connection)
  }
}
const handlePaths = new Map<number, string>()
let lane = Promise.resolve()
parentPort?.on('message', (request: SearchWorkerRequest) => {
  lane = lane.then(async () => {
    try {
      parentPort?.postMessage(await execute(request))
    } catch (error) {
      const command = request.command
      if ('handle' in command) {
        writes.get(command.handle)?.write.discard()
        writes.delete(command.handle)
        handlePaths.delete(command.handle)
      }
      parentPort?.postMessage({
        id: request.id,
        accepted: false,
        failure:
          command.op === 'begin' || command.op === 'batch' || command.op === 'finish'
            ? 'write'
            : undefined,
        error: error instanceof Error ? error.message : 'Session search failed'
      })
    }
  })
})
