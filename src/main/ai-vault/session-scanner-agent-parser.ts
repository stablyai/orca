import { parseQoderSessionFile } from './session-scanner-qoder-parser'
import { parseCodebuddySessionFile } from './session-scanner-codebuddy-parser'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
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
import { parseKiroSessionFile } from './session-scanner-kiro-parser'
import {
  captureOpenCodeSqliteSessionViaWorker,
  captureOpenCode2SqliteSessionViaWorker,
  captureZcodeSqliteSessionViaWorker,
  parseOpenCode2SqliteSessionViaWorker,
  parseOpenCodeSqliteSessionViaWorker,
  parseZcodeSqliteSessionViaWorker
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

/** Listing needs only a preview; active message sinks require the full transcript. */
async function readOpenCodeSqliteCandidate(
  sqliteCandidate: { dbPath: string; sessionId: string },
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal,
  agent?: 'opencode2' | 'zcode'
): Promise<AiVaultSession | null> {
  throwIfSignalAborted(signal)
  const request = { ...sqliteCandidate, platform, signal }
  if (!messages?.active) {
    const parse =
      agent === 'opencode2'
        ? parseOpenCode2SqliteSessionViaWorker
        : agent === 'zcode'
          ? parseZcodeSqliteSessionViaWorker
          : parseOpenCodeSqliteSessionViaWorker
    const session = await parse(request)
    throwIfSignalAborted(signal)
    return session
  }
  const capture =
    agent === 'opencode2'
      ? captureOpenCode2SqliteSessionViaWorker
      : agent === 'zcode'
        ? captureZcodeSqliteSessionViaWorker
        : captureOpenCodeSqliteSessionViaWorker
  const result = await capture(request)
  for (const message of result.messages) {
    throwIfSignalAborted(signal)
    messages.push(message)
  }
  throwIfSignalAborted(signal)
  return result.session
}

export async function parseAgentSessionFile(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  switch (candidate.agent) {
    case 'qoder':
      return parseQoderSessionFile(candidate.file, platform, messages)
    case 'codebuddy':
      return parseCodebuddySessionFile(candidate.file, platform, messages)
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
      return parseGeminiSessionFile(candidate.file, platform, messages, signal)
    case 'antigravity':
      return parseAntigravitySessionFile(candidate.file, platform, messages)
    case 'copilot':
      return parseCopilotSessionFile(candidate.file, platform, messages)
    case 'cursor':
      return parseCursorSessionFile(candidate.file, platform, messages)
    case 'opencode': {
      // Synthetic db#id paths identify SQLite sessions; real paths retain the legacy JSON parser.
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path)
      if (sqliteCandidate) {
        return readOpenCodeSqliteCandidate(sqliteCandidate, platform, messages, signal)
      }
      return parseOpenCodeSessionFile(candidate.file, platform, messages)
    }
    case 'opencode2': {
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path)
      if (sqliteCandidate) {
        return readOpenCodeSqliteCandidate(sqliteCandidate, platform, messages, signal, 'opencode2')
      }
      return null
    }
    case 'zcode': {
      const sqliteCandidate = splitOpenCodeSqliteCandidate(candidate.file.path, 'zcode')
      return sqliteCandidate
        ? readOpenCodeSqliteCandidate(sqliteCandidate, platform, messages, signal, 'zcode')
        : null
    }
    case 'grok':
      return parseGrokSessionFile(candidate.file, platform, messages)
    case 'hermes':
      return parseHermesSessionFile(candidate.file, platform, messages, signal)
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
      return parseClineSessionFile(candidate.file, platform, messages, signal)
    case 'devin':
      return parseDevinSessionFile(candidate.file, platform, messages, signal)
    case 'kimi':
      return parseKimiSessionFile(candidate.file, platform, messages)
    case 'muse':
      return parseMuseSessionFile(candidate.file, platform, messages)
    case 'jcode':
      return parseJcodeSessionFile(candidate.file, platform, messages)
    case 'kiro':
      return parseKiroSessionFile(candidate.file, platform, messages)
  }
}
