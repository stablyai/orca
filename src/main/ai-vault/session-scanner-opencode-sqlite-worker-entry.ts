import { parentPort } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import type {
  OpenCodeSqliteParseValue,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { withSessionSearchCapture } from './session-search-capture'

// Why (#8864): OpenCode SQLite reads use synchronous node:sqlite. Running them
// on this worker thread keeps the multi-GB-DB scan off the Electron main-process
// event loop. The client dispatches one request at a time, so this loop stays
// serial; imports must remain electron-free (see the worker-protocol note).

if (!parentPort) {
  throw new Error('OpenCode SQLite worker must run with a parent port.')
}
const port = parentPort

async function handleRequest(
  request: OpenCodeSqliteWorkerRequest
): Promise<OpenCodeSqliteWorkerResponse> {
  try {
    if (request.kind === 'list') {
      const issues: AiVaultScanIssue[] = []
      const candidates = await listOpenCodeSqliteSessions({
        dbPaths: request.dbPaths,
        limit: request.limit,
        issues
      })
      return { id: request.id, ok: true, value: { candidates, issues } }
    }
    return { id: request.id, ok: true, value: await parseSession(request) }
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// The parsers emit index rows into a capture scope, and that scope cannot span
// threads; capture here and hand the rows back with the session.
async function parseSession(
  request: Extract<OpenCodeSqliteWorkerRequest, { kind: 'parse' }>
): Promise<OpenCodeSqliteParseValue> {
  const parse = (): Promise<AiVaultSession | null> =>
    parseOpenCodeSqliteSession({
      dbPath: request.dbPath,
      sessionId: request.sessionId,
      platform: request.platform
    })
  if (!request.capture) {
    return { session: await parse(), messages: [] }
  }
  const captured = await withSessionSearchCapture(parse)
  return { session: captured.value, messages: captured.messages }
}

port.on('message', (request: OpenCodeSqliteWorkerRequest) => {
  void handleRequest(request).then((response) => {
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
