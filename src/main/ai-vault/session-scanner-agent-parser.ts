import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseDevinSessionFile } from './session-scanner-devin-parser'
import { parseGrokSessionFile } from './session-scanner-grok-parser'
import {
  parseDroidSessionFile,
  parseMessageGraphSessionFile,
  parseRovoSessionFile
} from './session-scanner-graph-parsers'
import {
  parseClaudeSessionFile,
  parseCodexSessionFile,
  parseGeminiSessionFile
} from './session-scanner-primary-parsers'
import {
  parseCopilotSessionFile,
  parseCursorSessionFile,
  parseHermesSessionFile,
  parseOpenCodeSessionFile
} from './session-scanner-secondary-parsers'
import type { SessionFileCandidate } from './session-scanner-types'

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
    case 'opencode':
      return parseOpenCodeSessionFile(candidate.file, platform)
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
    case 'droid':
      return parseDroidSessionFile(candidate.file, platform)
    case 'devin':
      return parseDevinSessionFile(candidate.file, platform)
  }
}
