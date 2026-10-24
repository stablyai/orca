import { parentPort } from 'node:worker_threads'
import { handleOpenCodeSqliteRequest } from '../ai-vault/session-scanner-opencode-sqlite-dispatch'
import type { OpenCodeSqliteWorkerRequest } from '../ai-vault/session-scanner-opencode-sqlite-worker-protocol'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'
import type {
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'

// Keep OpenCode dispatch separate because SSH/WSL relays bundle it without the other readers.

if (!parentPort) {
  throw new Error('Foreign SQLite reader worker must run with a parent port.')
}
const port = parentPort

type ReaderRequest = OpenCodeSqliteWorkerRequest | ForeignSqliteReaderRequest

function isOpenCodeRequest(request: ReaderRequest): request is OpenCodeSqliteWorkerRequest {
  return (
    request.kind === 'list' ||
    request.kind === 'parse' ||
    request.kind === 'capture' ||
    request.kind === 'native-page' ||
    request.kind === 'native-signal'
  )
}

function handle(request: ReaderRequest): Promise<ForeignSqliteReaderResponse> {
  return isOpenCodeRequest(request)
    ? handleOpenCodeSqliteRequest(request)
    : Promise.resolve(handleForeignSqliteReaderRequest(request))
}

port.on('message', (request: ReaderRequest) => {
  void handle(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // Reply with a serialization failure instead of leaving the client waiting for its timeout.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Foreign SQLite reader result could not be serialized.'
      })
    }
  })
})
