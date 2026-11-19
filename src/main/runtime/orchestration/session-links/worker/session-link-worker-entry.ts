// The session link worker: every session link read and transaction runs here on its own connection
// to the orchestration database, off the runtime's thread. One request at a time (the client
// serializes them), each answered by one store call or one transaction.
import { parentPort } from 'node:worker_threads'
import SyncDatabase from '../../../../sqlite/sync-database'
import { SessionLinkConnection } from './session-link-operations'
import type {
  SessionLinkWorkerRequest,
  SessionLinkWorkerResponse
} from './session-link-worker-protocol'
import { installWorkerSendLedger } from '../../../../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-session-links')

let opened: { path: string; db: SyncDatabase; connection: SessionLinkConnection } | null = null

/** The runtime created the file and its tables; this connection only joins it, as WAL allows. */
function connectionFor(path: string): SessionLinkConnection {
  if (opened?.path === path) {
    return opened.connection
  }
  closeSessionLinkDatabase()
  const db = new SyncDatabase(path, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    db.pragma('synchronous = NORMAL')
    db.pragma('journal_size_limit = 8388608')
    db.pragma('temp_store = MEMORY')
  } catch (error) {
    db.close()
    throw error
  }
  opened = { path, db, connection: new SessionLinkConnection(db) }
  return opened.connection
}

function closeSessionLinkDatabase(): void {
  opened?.db.close()
  opened = null
}

function answer(request: SessionLinkWorkerRequest): SessionLinkWorkerResponse {
  try {
    return connectionFor(request.path).answer(request)
  } catch (error) {
    // A file that failed to open is reopened by the next request.
    closeSessionLinkDatabase()
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

const port = parentPort
if (port) {
  port.on('message', (request: SessionLinkWorkerRequest) => {
    port.postMessage(answer(request))
  })
  port.on('close', closeSessionLinkDatabase)
}
