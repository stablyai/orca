// The orchestration reader thread: read-only queries over the orchestration database, off the runtime's
// thread. One request at a time (the client serializes them); each read's snapshot begins when it
// arrives, so it sees every commit main finished before sending it.
import { parentPort } from 'node:worker_threads'
import Database from '../../../../sqlite/sync-database'
import { installWorkerSendLedger } from '../../../../worker-threads/worker-send-ledger'
import { readConnectorWorkerCandidates } from '../connector-workers/connector-worker-candidates'
import type { OrchestrationDbConnection } from '../orchestration-db'
import type {
  OrchestrationReaderRequest,
  OrchestrationReaderResponse
} from './orchestration-reader-protocol'

installWorkerSendLedger('orca-orchestration-reader')

// Main's own lock wait; a longer one is the client's timeout to report.
const BUSY_TIMEOUT_MS = 5000

let opened: { path: string; connection: OrchestrationDbConnection } | null = null

function connectionFor(path: string): OrchestrationDbConnection {
  if (opened?.path !== path) {
    closeOrchestrationReader()
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS })
    opened = { path, connection: { db } }
  }
  return opened.connection
}

/** Exported for tests, which run it in process behind the same asynchronous boundary. */
export function handleOrchestrationRead(
  request: OrchestrationReaderRequest
): OrchestrationReaderResponse {
  try {
    const connection = connectionFor(request.path)
    // One snapshot per read, so its queries agree; it ends before the answer leaves.
    connection.db.exec('BEGIN')
    try {
      return { id: request.id, ok: true, value: runRead(connection, request) }
    } finally {
      connection.db.exec('COMMIT')
    }
  } catch (error) {
    // A connection left inside a transaction would refuse every later read; the next one reopens it.
    closeOrchestrationReader()
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function runRead(
  connection: OrchestrationDbConnection,
  request: OrchestrationReaderRequest
): unknown {
  switch (request.read) {
    case 'connectorWorkerCandidates':
      return readConnectorWorkerCandidates(connection, request.args.sessionIds, request.args.now)
  }
}

export function closeOrchestrationReader(): void {
  const closing = opened
  opened = null
  try {
    closing?.connection.db.close()
  } catch {
    // A connection that cannot close is dropped all the same; the next read opens a new one.
  }
}

const port = parentPort
if (port) {
  port.on('message', (request: OrchestrationReaderRequest) => {
    port.postMessage(handleOrchestrationRead(request))
  })
  port.on('close', closeOrchestrationReader)
}
