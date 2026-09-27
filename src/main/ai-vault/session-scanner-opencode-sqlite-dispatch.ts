import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { captureOpenCodeSqliteSession } from './session-scanner-opencode-sqlite-capture'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { listOpenCode2SqliteSessions } from './session-scanner-opencode2-sqlite-list'
import {
  captureOpenCode2SqliteSession,
  parseOpenCode2SqliteSession
} from './session-scanner-opencode2-sqlite'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'

import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'

export async function handleOpenCodeSqliteRequest(
  request: OpenCodeSqliteWorkerRequest
): Promise<OpenCodeSqliteWorkerResponse> {
  try {
    if (request.kind === 'list') {
      const issues: AiVaultScanIssue[] = []
      const candidates =
        request.agent === 'opencode2'
          ? await listOpenCode2SqliteSessions({
              dbPaths: request.dbPaths,
              limit: request.limit ?? Infinity,
              issues
            })
          : await listOpenCodeSqliteSessions({
              dbPaths: request.dbPaths,
              limit: request.limit ?? Infinity,
              issues
            })
      return { id: request.id, ok: true, value: { candidates, issues } }
    }
    if (request.kind === 'capture') {
      const capture =
        request.agent === 'opencode2'
          ? await captureOpenCode2SqliteSession(request)
          : await captureOpenCodeSqliteSession(request)
      return { id: request.id, ok: true, value: capture }
    }
    const parse = async () =>
      request.agent === 'opencode2'
        ? await parseOpenCode2SqliteSession({
            dbPath: request.dbPath,
            sessionId: request.sessionId,
            platform: request.platform
          })
        : await parseOpenCodeSqliteSession({
            dbPath: request.dbPath,
            sessionId: request.sessionId,
            platform: request.platform
          })
    const session = request.fullFirstUserPrompt
      ? await withFullFirstUserPromptCapture(parse)
      : await parse()
    return { id: request.id, ok: true, value: session }
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
