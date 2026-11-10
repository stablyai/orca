import {
  readSessionSearchSnapshotRows,
  applySessionSearchFileCountDelta
} from './session-search-snapshot-rows'
import type { SessionSearchCatalogCandidates } from './session-search-catalog-candidates'
import { SessionSearchForegroundWrite } from './session-search-foreground-write'
import { SessionSearchToolPurge } from './session-search-tool-purge'
import { readIndexGeneration } from './session-search-index-generation'
import { parentPort } from 'node:worker_threads'
import SyncDatabase from '../sqlite/sync-database'
import { withSpan, setActiveSink } from '../observability/tracer'
import { SessionSearchStore, type SessionSearchStateCounts } from './session-search-store'
import { SessionSearchEngine } from './session-search-engine'
import { createSessionSearchService } from './session-search-service'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { TranscriptSessionIdentity } from '../ai-vault/transcripts/session-transcript-consumers'
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
let candidates: SessionSearchCatalogCandidates | null = null
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
const foregroundWrites = new Map<number, SessionSearchForegroundWrite>()
const writes = new Map<
  number,
  { write: SessionSearchFileWrite; identity: TranscriptSessionIdentity | null }
>()

const rows = (path?: string, after?: string) => readSessionSearchSnapshotRows(store, path, after)
function resetCoverage(): void {
  if (!store) {
    return
  }
  counts = store.stateCounts()
  dataVersion = store.connection.pragma('data_version', { simple: true })
}
function delta(path: string, previous: SessionSearchSnapshotRow | undefined) {
  const row = rows(path)[0] ?? null
  applySessionSearchFileCountDelta(counts, row, previous)
  candidates?.rowChanged(path)
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
    candidates = store.catalogCandidates
    // Why: worker retirement closes the connection and its maintenance together.
    toolPurge = new SessionSearchToolPurge(
      store.connection,
      () => false,
      onMessagesChanged,
      onError
    )
    void toolPurge.request()
    store.setRetentionCutoffMs(c.cutoff)
    resetCoverage()
    return { id, reset: true, counts, generation: readIndexGeneration(store.connection) }
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
  let reset = false
  // Why: SQLite data_version changes only for foreign commits, including legacy writers' generation bumps.
  if (dataVersion !== store.connection.pragma('data_version', { simple: true })) {
    for (const { write } of writes.values()) {
      write.discard()
    }
    writes.clear()
    for (const write of foregroundWrites.values()) {
      write.discard()
    }
    foregroundWrites.clear()
    handlePaths.clear()
    resetCoverage()
    candidates?.execute({ kind: 'publication-wake' })
    reset = true
    void toolPurge?.request()
  }
  const changedPath = 'path' in c ? c.path : 'handle' in c ? handlePaths.get(c.handle) : undefined
  const previous = changedPath ? rows(changedPath)[0] : undefined
  let path: string | undefined
  let accepted = true
  switch (c.op) {
    case 'begin': {
      handlePaths.set(c.handle, c.candidate.file.path)
      if (c.unprepared) {
        const write = new SessionSearchForegroundWrite(
          store,
          c.candidate,
          c.mode,
          c.offset,
          c.unprepared.allowCovered,
          c.unprepared.canProvePrefix
        )
        foregroundWrites.set(c.handle, write)
        return { id, reset, accepted: true, prefixTarget: write.target, counts }
      }
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
    case 'read-batch':
      foregroundWrites.get(c.handle)?.add(c.events, c.identity)
      accepted = foregroundWrites.has(c.handle)
      break
    case 'finish': {
      const foreground = foregroundWrites.get(c.handle)
      if (foreground) {
        accepted = foreground.finish(c.outcome)
        foregroundWrites.delete(c.handle)
        if (accepted) {
          store.setFileState(handlePaths.get(c.handle)!, 'current')
        }
        break
      }
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
      foregroundWrites.get(c.handle)?.discard()
      foregroundWrites.delete(c.handle)
      writes.get(c.handle)?.write.discard()
      writes.delete(c.handle)
      break
    case 'state':
      store.setFileState(c.path, c.state, c.mtime)
      path = c.path
      break
    case 'remove':
      accepted = store.removeFile(c.path)
      path = c.path
      break
    case 'purge': {
      store.setRetentionCutoffMs(c.cutoff)
      await withSpan('aiVault.search.purge', () => store!.purgeOlderThan(c.cutoff))
      counts = store.stateCounts()
      return {
        id,
        reset: true,
        counts,
        generation: readIndexGeneration(store.connection)
      }
    }
    case 'coverage':
      if (c.paths.length > 256) {
        throw new Error('Session search coverage exceeds page budget')
      }
      return { id, reset, coverage: c.paths.flatMap((path) => rows(path)), counts }
    case 'file-page':
      return { id, reset, filePage: rows(undefined, c.after), counts }
    case 'candidates': {
      const path = c.command.kind === 'withdraw' ? c.command.path : undefined
      const previous = path ? rows(path)[0] : undefined
      const result = candidates!.execute(c.command)
      return {
        id,
        reset,
        candidates: result,
        deltas: path ? [delta(path, previous)] : undefined,
        counts,
        generation: readIndexGeneration(store.connection)
      }
    }
    case 'catalog':
      return { id, reset, catalog: await store.catalog(c.command), counts }
    case 'sync':
      break
  }
  if (c.op === 'batch' || c.op === 'read-batch' || c.op === 'finish') {
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
    reset,
    deltas: path ? [delta(path, previous)] : undefined,
    counts,
    generation: readIndexGeneration(store.connection)
  }
}
const handlePaths = new Map<number, string>()
let lane = Promise.resolve()
parentPort?.on('message', (request: SearchWorkerRequest) => {
  lane = lane.then(async () => {
    try {
      const response = await execute(request)
      response.catalogPending = candidates?.hasPending ?? false
      parentPort?.postMessage(response)
    } catch (error) {
      const command = request.command
      if ('handle' in command) {
        foregroundWrites.get(command.handle)?.discard()
        foregroundWrites.delete(command.handle)
        writes.get(command.handle)?.write.discard()
        writes.delete(command.handle)
        handlePaths.delete(command.handle)
      }
      parentPort?.postMessage({
        id: request.id,
        accepted: false,
        failure:
          command.op === 'begin' ||
          command.op === 'batch' ||
          command.op === 'read-batch' ||
          command.op === 'finish'
            ? 'write'
            : undefined,
        error: error instanceof Error ? error.message : 'Session search failed'
      })
    }
  })
})
