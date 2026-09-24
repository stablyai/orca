import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { parseAntigravitySessionFile } from './session-scanner-antigravity-parser'
import { parseDroidSessionFile } from './session-scanner-droid-parser'
import { parseClineSessionFile } from './session-scanner-cline-parser'
import { parseGrokSessionFile } from './session-scanner-grok-parser'
import { parseMessageGraphSessionFile, parseRovoSessionFile } from './session-scanner-graph-parsers'
import { parseKimiSessionFile } from './session-scanner-kimi-parser'
import { parseMuseSessionFile } from './session-scanner-muse-parser'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { parseJcodeSessionFile } from './session-scanner-jcode-parser'
import {
  captureOpenCodeSqliteSessionViaWorker,
  captureOpenCode2SqliteSessionViaWorker,
  parseOpenCode2SqliteSessionViaWorker,
  parseOpenCodeSqliteSessionViaWorker
} from './session-scanner-opencode-sqlite-worker-spawn'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import { parseGeminiSessionFile } from './session-scanner-gemini-parsers'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import { parseCopilotSessionFile } from './session-scanner-copilot-parser'
import { parseCursorSessionFile } from './session-scanner-cursor-parser'
import { parseHermesSessionFile } from './session-scanner-hermes-parser'
import { parseOpenCodeSessionFile } from './session-scanner-opencode-parser'
import type { SessionFileCandidate } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'

/**
 * Read an OpenCode SQLite session on the worker thread.
 *
 * Two request kinds rather than one, chosen by whether anyone is listening: a
 * list scan wants the newest few messages for the panel preview, so asking for
 * the whole transcript would read every part of every session on every refresh.
 * A read with a sink is the search index's, and that one needs all of it.
 */
async function readOpenCodeSqliteCandidate(
  sqliteCandidate: { dbPath: string; sessionId: string },
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const request = { ...sqliteCandidate, platform }
  if (!messages?.active) {
    return parseOpenCodeSqliteSessionViaWorker(request)
  }
  const capture = await captureOpenCodeSqliteSessionViaWorker(request)
  for (const message of capture.messages) {
    messages.push(message)
  }
  return capture.session
}

/**
 * Parse a single agent session file into an `AiVaultSession`. Routes to the
 * appropriate agent-specific parser based on `candidate.agent`. For OpenCode
 * SQLite candidates (synthetic `db#id` paths), routes to
 * `parseOpenCodeSqliteSession` instead of the legacy JSON parser.
 * @param candidate - The session file candidate to parse.
 * @param platform - The platform to use for resume command generation.
 * @param messages - Where the parser publishes every decoded message.
 * @returns The parsed `AiVaultSession`, or `null` if parsing fails.
 */
export async function parseAgentSessionFile(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  switch (candidate.agent) {
    case 'claude':
      return parseClaudeSessionFile(candidate.file, platform, messages)
    case 'codex':
      return parseCodexSessionFile(
        candidate.file,
        platform,
        candidate.codexHome,
        undefined,
        messages
      )
    case 'gemini':
      return parseGeminiSessionFile(candidate.file, platform, messages)
    case 'antigravity':
      return parseAntigravitySessionFile(candidate.file, platform, messages)
    case 'copilot':
      return parseCopilotSessionFile(candidate.file, platform, messages)
    case 'cursor':
      return parseCursorSessionFile(candidate.file, platform, messages)
    case 'opencode': {
      // Why: OpenCode 1.17.x sessions are read from SQLite via a synthetic
      // <dbPath>#<sessionId> candidate path. Legacy file-based sessions use
      // real filesystem paths and fall through to the JSON parser.
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path)
      if (sqliteCandidate) {
        return readOpenCodeSqliteCandidate(sqliteCandidate, platform, messages)
      }
      return parseOpenCodeSessionFile(candidate.file, platform, messages)
    }
    case 'opencode2': {
      // Why: opencode2 (beta) sessions are read from the channel-scoped SQLite
      // DB (session_v2 schema) via the same synthetic <dbPath>#<sessionId>
      // candidate path; there is no legacy file store.
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path)
      if (sqliteCandidate) {
        if (messages?.active) {
          const capture = await captureOpenCode2SqliteSessionViaWorker({
            dbPath: sqliteCandidate.dbPath,
            sessionId: sqliteCandidate.sessionId,
            platform
          })
          for (const message of capture.messages) {
            messages.push(message)
          }
          return capture.session
        }
        return parseOpenCode2SqliteSessionViaWorker({
          dbPath: sqliteCandidate.dbPath,
          sessionId: sqliteCandidate.sessionId,
          platform
        })
      }
      return null
    }
    case 'grok':
      return parseGrokSessionFile(candidate.file, platform, messages)
    case 'hermes':
      return parseHermesSessionFile(candidate.file, platform, messages)
    case 'rovo':
      return parseRovoSessionFile(candidate.file, platform, messages)
    case 'openclaw':
      return parseMessageGraphSessionFile('openclaw', candidate.file, platform, messages)
    case 'pi':
      return parseMessageGraphSessionFile('pi', candidate.file, platform, messages)
    case 'omp':
      return parseMessageGraphSessionFile('omp', candidate.file, platform, messages)
    case 'prime-agent':
      return parseMessageGraphSessionFile('prime-agent', candidate.file, platform, messages)
    case 'droid':
      return parseDroidSessionFile(candidate.file, platform, messages)
    case 'cline':
      return parseClineSessionFile(candidate.file, platform, messages)
    case 'devin':
      return parseDevinSessionFile(candidate.file, platform, messages)
    case 'kimi':
      return parseKimiSessionFile(candidate.file, platform, messages)
    case 'muse':
      return parseMuseSessionFile(candidate.file, platform, messages)
    case 'jcode':
      return parseJcodeSessionFile(candidate.file, platform, messages)
  }
}
