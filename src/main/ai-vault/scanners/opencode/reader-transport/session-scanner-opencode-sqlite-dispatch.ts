import {
  listDevinSqliteSessions,
  parseDevinSqliteSession,
  captureDevinSqliteSession
} from '../../devin/session-scanner-devin-sqlite'
import { readOpenCode2ForkCoverage } from '../../../../native-chat/transcript-history/opencode/transcript-opencode2-fork-coverage'
import { readOpenCodeDatabase } from '../sqlite/session-scanner-opencode-sqlite-open'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from '../../../../native-chat/transcript-history/opencode/transcript-opencode-sqlite-query'
import type { AiVaultScanIssue } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { captureOpenCodeSqliteSession } from '../sqlite/session-scanner-opencode-sqlite-capture'
import { listOpenCodeSqliteSessions } from '../sqlite/session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from '../sqlite/session-scanner-opencode-sqlite'
import { listOpenCode2SqliteSessions } from '../../opencode2/session-scanner-opencode2-sqlite-list'
import {
  captureOpenCode2SqliteSession,
  parseOpenCode2SqliteSession
} from '../../opencode2/session-scanner-opencode2-sqlite'
import {
  hasHermesSession,
  readHermesChatTranscript
} from '../../../../native-chat/transcript-history/hermes/transcript-hermes-sqlite'
import {
  captureHermesSqliteSession,
  listHermesSqliteSessions,
  parseHermesSqliteSession
} from '../../hermes/session-scanner-hermes-sqlite'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'

import { withFullFirstUserPromptCapture } from '../../../prompts/session-scanner-first-user-prompt-capture'

const historyReaders = {
  opencode: {
    list: listOpenCodeSqliteSessions,
    parse: parseOpenCodeSqliteSession,
    capture: captureOpenCodeSqliteSession
  },
  opencode2: {
    list: listOpenCode2SqliteSessions,
    parse: parseOpenCode2SqliteSession,
    capture: captureOpenCode2SqliteSession
  },
  hermes: {
    list: listHermesSqliteSessions,
    parse: parseHermesSqliteSession,
    capture: captureHermesSqliteSession
  },
  devin: {
    list: listDevinSqliteSessions,
    parse: parseDevinSqliteSession,
    capture: captureDevinSqliteSession
  }
}

export async function handleOpenCodeSqliteRequest(
  request: OpenCodeSqliteWorkerRequest
): Promise<OpenCodeSqliteWorkerResponse> {
  try {
    if (request.kind === 'fork-coverage') {
      const value = readOpenCodeDatabase({
        dbPath: request.dbPath,
        read: (db) => readOpenCode2ForkCoverage(db, request.sessionId, request.sourceSessionId)
      })
      return { id: request.id, ok: true, value }
    }
    if (request.kind === 'hermes-history') {
      return { id: request.id, ok: true, value: readHermesChatTranscript(request) }
    }
    if (request.kind === 'hermes-exists') {
      return { id: request.id, ok: true, value: { exists: hasHermesSession(request) } }
    }
    if (request.kind === 'native-page' || request.kind === 'native-signal') {
      const value =
        request.kind === 'native-signal'
          ? readOpenCodeTranscriptSignal(request.dbPath, request.sessionId, request.agent)
          : readOpenCodeTranscriptPage({ ...request, limit: request.limit ?? 50 })
      return { id: request.id, ok: true, value }
    }
    const agent = request.agent === 'zcode' ? 'zcode' : 'opencode'
    const reader =
      historyReaders[request.agent && request.agent !== 'zcode' ? request.agent : 'opencode']
    if (request.kind === 'list') {
      const issues: AiVaultScanIssue[] = []
      const candidates = await reader.list({
        ...request,
        agent,
        limit: request.limit ?? Infinity,
        issues
      })
      return { id: request.id, ok: true, value: { candidates, issues } }
    }
    if (request.kind === 'capture') {
      const value = await reader.capture({ ...request, agent })
      return { id: request.id, ok: true, value }
    }
    if (request.kind !== 'parse') {
      throw new Error('Unsupported OpenCode SQLite request')
    }
    const parse = async () => reader.parse({ ...request, agent })
    const session = request.fullFirstUserPrompt
      ? await withFullFirstUserPromptCapture(parse)
      : await parse()
    return { id: request.id, ok: true, value: session }
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
