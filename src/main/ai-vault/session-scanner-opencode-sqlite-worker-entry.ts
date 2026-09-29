import { parentPort } from 'node:worker_threads'
import type { OpenCodeSqliteWorkerRequest } from './session-scanner-opencode-sqlite-worker-protocol'
import { handleOpenCodeSqliteRequest } from './session-scanner-opencode-sqlite-dispatch'

if (!parentPort) {
  throw new Error('OpenCode SQLite worker must run with a parent port.')
}
const port = parentPort

port.on('message', (request: OpenCodeSqliteWorkerRequest) => {
  void handleOpenCodeSqliteRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its timeout; fail that request fast instead.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'OpenCode SQLite worker result could not be serialized.'
      })
    }
  })
})
