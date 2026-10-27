import { basename } from 'node:path'
import { readJsonlFileSnapshot } from '../usage/jsonl-file-snapshot'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type {
  ClaudeUsageParseResumeState,
  ClaudeUsageParsedTurn,
  ClaudeUsageProcessedFile
} from './types'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import {
  buildJsonlFileCheckpoint,
  jsonlPhysicalFileId,
  openJsonlFileReader,
  resolveJsonlFileCheckpoint,
  validateJsonlFileReader,
  type JsonlFileCheckpoint
} from '../usage/jsonl-file-checkpoint'

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
      /** TTL split of `cache_creation_input_tokens`; 1h writes bill at 2x base input. */
      cache_creation?: {
        ephemeral_5m_input_tokens?: number
        ephemeral_1h_input_tokens?: number
      }
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
    cacheWriteTokens: turn.cacheWriteTokens,
    cacheWrite1hTokens: turn.cacheWrite1hTokens
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
        // Later streaming rows can contain more complete usage for the same turn.
        existing.inputTokens = Math.max(existing.inputTokens, turn.inputTokens)
        existing.outputTokens = Math.max(existing.outputTokens, turn.outputTokens)
        existing.cacheReadTokens = Math.max(existing.cacheReadTokens, turn.cacheReadTokens)
        existing.cacheWriteTokens = Math.max(existing.cacheWriteTokens, turn.cacheWriteTokens)
        existing.cacheWrite1hTokens = Math.max(existing.cacheWrite1hTokens, turn.cacheWrite1hTokens)
        continue
      }
    }

    deduped.push(turn)
    if (turn.dedupeKey) {
      dedupeIndexByKey.set(turn.dedupeKey, deduped.length - 1)
    }
  }

  return deduped
}

// Assumes serializers spell ASCII `assistant` literally; parsed.type remains authoritative.
function mayEncodeAssistantType(line: string): boolean {
  return line.includes('assistant')
}

function parseClaudeUsageSourceRecord(
  line: string,
  fallbackSessionId: string | null = null
): ClaudeUsageParsedSourceTurn | null {
  // Skip large user/tool-result payloads before parsing; only assistant records carry usage.
  if (!mayEncodeAssistantType(line)) {
    return null
  }
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
  // Keep the implied 5m remainder nonnegative on partial rows.
  const cacheWrite1hTokens = Math.min(
    usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheWriteTokens
  )

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) {
    return null
  }

  return {
    sessionId,
    timestamp: parsed.timestamp,
    model: parsed.message?.model ?? null,
    cwd: parsed.cwd ?? null,
    gitBranch: parsed.gitBranch ?? null,
    // Forks rewrite sessionId; message IDs and UUID fallbacks preserve ownership across files.
    dedupeKey: buildClaudeUsageDedupeKey(parsed),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens
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

export type ClaudeUsageScanFile = {
  processedFile: ClaudeUsageProcessedFile
  turns: ClaudeUsageParsedSourceTurn[]
  resumed: boolean
  checkpoint: JsonlFileCheckpoint | null
  committedLineCount: number
}

export async function readClaudeUsageScanFile(
  filePath: string,
  resume?: ClaudeUsageParseResumeState | null
): Promise<ClaudeUsageScanFile> {
  let candidate = resume
  while (true) {
    const reader = await openJsonlFileReader(filePath)
    let read: ClaudeUsageScanFile
    try {
      const verifiedResume =
        candidate && (await resolveJsonlFileCheckpoint(filePath, candidate, reader))
      const startOffset = verifiedResume?.parsedBytes ?? 0
      let lineCount = verifiedResume && candidate ? candidate.lineCount : 0
      let committedLineCount = lineCount
      let parsedBytes = startOffset
      let partialTailProducedTurn = false
      const turns: ClaudeUsageParsedSourceTurn[] = []
      const fallbackSessionId = basename(filePath, '.jsonl')
      for await (const { line, endOffset, terminated } of readJsonlLinesFromOffset(
        filePath,
        startOffset,
        reader
      )) {
        lineCount++
        const parsed = parseClaudeUsageSourceRecord(line, fallbackSessionId)
        if (terminated) {
          parsedBytes = endOffset
          committedLineCount = lineCount
        } else if (parsed) {
          partialTailProducedTurn = true
        }
        if (parsed) {
          turns.push(parsed)
        }
      }
      const checkpoint = partialTailProducedTurn
        ? null
        : await buildJsonlFileCheckpoint(filePath, parsedBytes, null, reader)
      if (!(await validateJsonlFileReader(reader, verifiedResume))) {
        candidate = null
        continue
      }
      read = {
        processedFile: {
          path: filePath,
          mtimeMs: reader.stats.mtimeMs,
          size: reader.stats.size,
          lineCount,
          physicalFileId: jsonlPhysicalFileId(reader.stats),
          ctimeMs: reader.stats.ctimeMs
        },
        turns,
        resumed: Boolean(verifiedResume),
        checkpoint,
        committedLineCount
      }
    } finally {
      await reader.handle.close()
    }
    return { ...read, turns: dedupeClaudeUsageTurns(read.turns) }
  }
}

export async function getClaudeUsageProcessedFileStat(
  filePath: string
): Promise<Omit<ClaudeUsageProcessedFile, 'lineCount'> & { physicalFileId: string | null }> {
  const fileStat = await readJsonlFileSnapshot(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    physicalFileId: jsonlPhysicalFileId(fileStat),
    ctimeMs: fileStat.ctimeMs
  }
}
