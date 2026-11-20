import { stat } from 'node:fs/promises'
import type { AiVaultSession } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  HANDOFF_AGENTS,
  isHandoffAgent,
  type HandoffAgent
} from '../../shared/agent-handoff-agents'
import { parseCodexSessionFile } from '../ai-vault/scanners/codex/session-scanner-codex-parser'
import { parseMessageGraphSessionFile } from '../ai-vault/scanners/session-scanner-graph-parsers'
import { parseClaudeSessionFile } from '../ai-vault/scanners/claude/session-scanner-primary-parsers'
import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'

export { HANDOFF_AGENTS, isHandoffAgent }
export type { HandoffAgent }

export type HandoffPackMode = 'summary' | 'full'

export type HandoffPackOptions = {
  mode?: HandoffPackMode
  /** Summary tail length; full mode ignores it. */
  maxMessages?: number
  /** Total text budget; oldest messages drop first when exceeded. */
  maxChars?: number
}

export type AgentHandoffPack = {
  agent: HandoffAgent
  sessionId: string
  title: string
  cwd: string | null
  model: string | null
  createdAt: string | null
  updatedAt: string | null
  totalMessages: number
  mode: HandoffPackMode
  messages: TranscriptMessage[]
  truncated: boolean
}

const DEFAULT_SUMMARY_MESSAGES = 20
const DEFAULT_SUMMARY_CHARS = 12000
const DEFAULT_FULL_CHARS = 60000

function messageChars(messages: readonly TranscriptMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += message.text.length
  }
  return total
}

// Summary keeps the opening ask for intent plus the recent tail for state; the
// anchor at index 0 survives the char budget so a handoff never loses the goal.
export function shapeHandoffMessages(
  messages: readonly TranscriptMessage[],
  mode: HandoffPackMode,
  maxMessages = DEFAULT_SUMMARY_MESSAGES,
  maxChars = mode === 'summary' ? DEFAULT_SUMMARY_CHARS : DEFAULT_FULL_CHARS
): { messages: TranscriptMessage[]; truncated: boolean } {
  let kept: TranscriptMessage[]
  if (mode === 'full' || messages.length === 0) {
    kept = [...messages]
  } else {
    const firstUserIndex = messages.findIndex((message) => message.role === 'user')
    const firstUser = firstUserIndex !== -1 ? messages[firstUserIndex] : undefined
    const tail = messages.slice(Math.max(0, messages.length - maxMessages))
    kept = firstUser && !tail.includes(firstUser) ? [firstUser, ...tail] : [...tail]
  }
  const head = kept[0]
  const anchor = mode === 'summary' && head?.role === 'user' ? 1 : 0
  let chars = messageChars(kept)
  let cursor = anchor
  while (chars > maxChars && kept.length - cursor > 1) {
    const dropped = kept[cursor]
    if (!dropped) {
      break
    }
    chars -= dropped.text.length
    kept.splice(cursor, 1)
  }
  let textTruncated = false
  if (chars > maxChars && kept.length > 0) {
    const last = kept.at(-1)
    if (last) {
      kept[kept.length - 1] = {
        ...last,
        text: `${last.text.slice(0, Math.max(0, maxChars))}...`
      }
      textTruncated = true
    }
  }
  return { messages: kept, truncated: textTruncated || kept.length < messages.length }
}

export function renderAgentHandoffPrompt(pack: AgentHandoffPack): string {
  const lines = [
    `# Continued from ${pack.agent} session "${pack.title}" (${pack.sessionId})`,
    `- Cwd: ${pack.cwd ?? 'unknown'}`,
    `- Model: ${pack.model ?? 'unknown'}`,
    `- Messages: ${pack.totalMessages} total, ${pack.messages.length} included${pack.truncated ? ' (truncated)' : ''}`,
    '## Transcript (oldest to newest)'
  ]
  for (const message of pack.messages) {
    lines.push(`**${message.role}**: ${message.text}`)
  }
  return lines.join('\n')
}

function readHandoffTranscript(
  agent: HandoffAgent,
  file: FileWithMtime,
  push: (message: TranscriptMessage) => void
): Promise<AiVaultSession | null> {
  const sink = { active: true, push }
  switch (agent) {
    case 'claude':
      return parseClaudeSessionFile(file, process.platform, sink)
    case 'codex':
      return parseCodexSessionFile(file, process.platform, null, undefined, sink)
    case 'pi':
      return parseMessageGraphSessionFile('pi', file, process.platform, sink)
  }
}

// Read-only: decodes one transcript file into a handoff pack. Null when the
// file is missing or the parser rejects it; never throws for absent paths.
export async function buildAgentHandoffPack(
  agent: HandoffAgent,
  filePath: string,
  options: HandoffPackOptions = {}
): Promise<AgentHandoffPack | null> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }
  const collected: TranscriptMessage[] = []
  const session = await readHandoffTranscript(
    agent,
    { path: filePath, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() },
    (message) => collected.push(message)
  )
  if (!session) {
    return null
  }
  const mode = options.mode ?? 'summary'
  const shaped = shapeHandoffMessages(collected, mode, options.maxMessages, options.maxChars)
  return {
    agent,
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    totalMessages: collected.length,
    mode,
    messages: shaped.messages,
    truncated: shaped.truncated
  }
}
