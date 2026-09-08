import { OpenCodeWorkerSearchCapture } from './session-search-opencode-worker-capture'
import { parentPort } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import type {
  OpenCodeSqliteParseValue,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteParentMessage,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { withStreamingSessionSearchCapture } from './session-search-capture'

// Why (#8864): OpenCode SQLite reads use synchronous node:sqlite. Running them
// on this worker thread keeps the multi-GB-DB scan off the Electron main-process
// event loop. The client dispatches one request at a time, so this loop stays
// serial; imports must remain electron-free (see the worker-protocol note).

if (!parentPort) {
  throw new Error('OpenCode SQLite worker must run with a parent port.')
}
const port = parentPort
const captures = new Map<number, OpenCodeWorkerSearchCapture>()

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
      return { id: request.id, kind: 'result', value: { candidates, issues } }
    }
    return { id: request.id, kind: 'result', value: await parseSession(request) }
  } catch (err) {
    return {
      id: request.id,
      kind: 'error',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// The final reply follows all acknowledged capture batches.
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
    return { session: await parse() }
  }
  const capture = new OpenCodeWorkerSearchCapture(request.id, (batch) => port.postMessage(batch))
  captures.set(request.id, capture)
  // The producer marks this box from inside the capture scope; it does not
  // survive the thread hop, so it rides back on the parse value instead.
  const degraded = { incomplete: false }
  try {
    const session = await withStreamingSessionSearchCapture(capture, parse, degraded)
    await capture.flush()
    return degraded.incomplete ? { session, captureIncomplete: true } : { session }
  } finally {
    captures.delete(request.id)
  }
}

port.on('message', (request: OpenCodeSqliteParentMessage) => {
  if (request.kind === 'captureAck') {
    captures.get(request.id)?.acknowledge(request.batch)
    return
  }
  void handleRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its timeout; fail that request fast instead.
      port.postMessage({
        id: request.id,
        kind: 'error',
        error: 'OpenCode SQLite worker result could not be serialized.'
      })
    }
  })
})
