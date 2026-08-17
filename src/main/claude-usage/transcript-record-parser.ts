import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ClaudeUsageParsedTurn, ClaudeUsageProcessedFile } from './types'

type ClaudeUsageSourceRecord = {
  type?: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  requestId?: string
  /** Stable row id when present; preserved across fork-copied history. */
  uuid?: string
  isSidechain?: boolean
  agentId?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

export type ClaudeUsageParsedSourceTurn = ClaudeUsageParsedTurn & {
  dedupeKey: string | null
}

export function stripClaudeSourceMetadata(
  turn: ClaudeUsageParsedSourceTurn
): ClaudeUsageParsedTurn {
  return {
    sessionId: turn.sessionId,
    timestamp: turn.timestamp,
    model: turn.model,
    cwd: turn.cwd,
    gitBranch: turn.gitBranch,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens
  }
}

function dedupeClaudeUsageTurns(
  turns: ClaudeUsageParsedSourceTurn[]
): ClaudeUsageParsedSourceTurn[] {
  const dedupeIndexByKey = new Map<string, number>()
  const deduped: ClaudeUsageParsedSourceTurn[] = []

  for (const turn of turns) {
    if (turn.dedupeKey) {
      const existingIndex = dedupeIndexByKey.get(turn.dedupeKey)
      if (existingIndex !== undefined) {
        const existing = deduped[existingIndex]
        // Why: Claude Code streams repeated assistant rows with the same
        // message/request IDs; later rows can contain more complete usage.
        existing.inputTokens = Math.max(existing.inputTokens, turn.inputTokens)
        existing.outputTokens = Math.max(existing.outputTokens, turn.outputTokens)
        existing.cacheReadTokens = Math.max(existing.cacheReadTokens, turn.cacheReadTokens)
        existing.cacheWriteTokens = Math.max(existing.cacheWriteTokens, turn.cacheWriteTokens)
        continue
      }
    }

    deduped.push({ ...turn })
    if (turn.dedupeKey) {
      dedupeIndexByKey.set(turn.dedupeKey, deduped.length - 1)
    }
  }

  return deduped
}

function parseClaudeUsageSourceRecord(
  line: string,
  fallbackSessionId: string | null = null
): ClaudeUsageParsedSourceTurn | null {
  let parsed: ClaudeUsageSourceRecord
  try {
    parsed = JSON.parse(line) as ClaudeUsageSourceRecord
  } catch {
    return null
  }

  if (parsed.type !== 'assistant') {
    return null
  }
  const sessionId = parsed.sessionId ?? fallbackSessionId
  if (!sessionId || !parsed.timestamp) {
    return null
  }

  const usage = parsed.message?.usage
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) {
    return null
  }

  return {
    sessionId,
    timestamp: parsed.timestamp,
    model: parsed.message?.model ?? null,
    cwd: parsed.cwd ?? null,
    gitBranch: parsed.gitBranch ?? null,
    // Why: forks rewrite sessionId but keep message/request ids (and usually
    // uuid). Prefer the strongest stable identity available so ownership still
    // works when requestId is missing on older or partial rows.
    dedupeKey: buildClaudeUsageDedupeKey(parsed),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  }
}

function buildClaudeUsageDedupeKey(parsed: ClaudeUsageSourceRecord): string | null {
  const messageId = parsed.message?.id?.trim()
  const requestId = parsed.requestId?.trim()
  if (messageId && requestId) {
    return `${messageId}:${requestId}`
  }
  if (messageId) {
    return `msg:${messageId}`
  }
  const uuid = parsed.uuid?.trim()
  if (uuid) {
    return `uuid:${uuid}`
  }
  return null
}

export function parseClaudeUsageRecord(line: string): ClaudeUsageParsedTurn | null {
  const parsed = parseClaudeUsageSourceRecord(line)
  return parsed ? stripClaudeSourceMetadata(parsed) : null
}

export async function parseClaudeUsageFile(filePath: string): Promise<ClaudeUsageParsedTurn[]> {
  const turns: ClaudeUsageParsedSourceTurn[] = []
  const fallbackSessionId = basename(filePath, '.jsonl')
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const parsed = parseClaudeUsageSourceRecord(line, fallbackSessionId)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return dedupeClaudeUsageTurns(turns).map(stripClaudeSourceMetadata)
}

export async function readClaudeUsageScanFile(filePath: string): Promise<{
  processedFile: ClaudeUsageProcessedFile
  turns: ClaudeUsageParsedSourceTurn[]
}> {
  const fileStat = await stat(filePath)
  let lineCount = 0
  const turns: ClaudeUsageParsedSourceTurn[] = []
  const fallbackSessionId = basename(filePath, '.jsonl')
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    lineCount++
    const parsed = parseClaudeUsageSourceRecord(line, fallbackSessionId)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return {
    processedFile: {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      lineCount
    },
    turns: dedupeClaudeUsageTurns(turns)
  }
}
