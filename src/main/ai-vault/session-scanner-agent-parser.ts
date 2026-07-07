import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { parseDroidSessionFile } from './session-scanner-droid-parser'
import { parseGrokSessionFile } from './session-scanner-grok-parser'
import { parseMessageGraphSessionFile, parseRovoSessionFile } from './session-scanner-graph-parsers'
import { parseKimiSessionFile } from './session-scanner-kimi-parser'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { parseClaudeSessionFile, parseGeminiSessionFile } from './session-scanner-primary-parsers'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import {
  parseCopilotSessionFile,
  parseCursorSessionFile,
  parseHermesSessionFile,
  parseOpenCodeSessionFile
} from './session-scanner-secondary-parsers'
import type { SessionFileCandidate } from './session-scanner-types'

/**
 * Parse a single agent session file into an `AiVaultSession`. Routes to the
 * appropriate agent-specific parser based on `candidate.agent`. For OpenCode
 * SQLite candidates (synthetic `db#id` paths), routes to
 * `parseOpenCodeSqliteSession` instead of the legacy JSON parser.
 * @param candidate - The session file candidate to parse.
 * @param platform - The platform to use for resume command generation.
 * @returns The parsed `AiVaultSession`, or `null` if parsing fails.
 */
export async function parseAgentSessionFile(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform
): Promise<AiVaultSession | null> {
  switch (candidate.agent) {
    case 'claude':
      return parseClaudeSessionFile(candidate.file, platform)
    case 'codex':
      return parseCodexSessionFile(candidate.file, platform, candidate.codexHome)
    case 'gemini':
      return parseGeminiSessionFile(candidate.file, platform)
    case 'copilot':
      return parseCopilotSessionFile(candidate.file, platform)
    case 'cursor':
      return parseCursorSessionFile(candidate.file, platform)
    case 'opencode': {
      // Why: OpenCode 1.17.x sessions are read from SQLite via a synthetic
      // <dbPath>#<sessionId> candidate path. Legacy file-based sessions use
      // real filesystem paths and fall through to the JSON parser.
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path)
      if (sqliteCandidate) {
        return parseOpenCodeSqliteSession({
          dbPath: sqliteCandidate.dbPath,
          sessionId: sqliteCandidate.sessionId,
          platform
        })
      }
      return parseOpenCodeSessionFile(candidate.file, platform)
    }
    case 'grok':
      return parseGrokSessionFile(candidate.file, platform)
    case 'hermes':
      return parseHermesSessionFile(candidate.file, platform)
    case 'rovo':
      return parseRovoSessionFile(candidate.file, platform)
    case 'openclaw':
      return parseMessageGraphSessionFile('openclaw', candidate.file, platform)
    case 'pi':
      return parseMessageGraphSessionFile('pi', candidate.file, platform)
    case 'omp':
      return parseMessageGraphSessionFile('omp', candidate.file, platform)
    case 'droid':
      return parseDroidSessionFile(candidate.file, platform)
    case 'devin':
      return parseDevinSessionFile(candidate.file, platform)
    case 'kimi':
      return parseKimiSessionFile(candidate.file, platform)
  }
}
