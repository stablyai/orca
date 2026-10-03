import { parentPort } from 'node:worker_threads'
import { handleOpenCodeSqliteRequest } from '../ai-vault/session-scanner-opencode-sqlite-dispatch'
import type { OpenCodeSqliteWorkerRequest } from '../ai-vault/session-scanner-opencode-sqlite-worker-protocol'
import { handleForeignSqliteReaderRequest } from './foreign-sqlite-reader-dispatch'
import type {
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'

// Why two dispatches: the OpenCode one is also bundled into the SSH/WSL relay
// reader, so the other readers stay out of it and ship only in this entry.

if (!parentPort) {
  throw new Error('Foreign SQLite reader worker must run with a parent port.')
}
const port = parentPort

type ReaderRequest = OpenCodeSqliteWorkerRequest | ForeignSqliteReaderRequest

function isOpenCodeRequest(request: ReaderRequest): request is OpenCodeSqliteWorkerRequest {
  return request.kind === 'list' || request.kind === 'parse' || request.kind === 'capture'
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
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its timeout; fail that request fast instead.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Foreign SQLite reader result could not be serialized.'
      })
    }
  })
})
