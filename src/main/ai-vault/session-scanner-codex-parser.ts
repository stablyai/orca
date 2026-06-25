import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createInterface } from 'readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from './session-scanner-accumulator'
import type { CodexUsageSnapshot, FileWithMtime } from './session-scanner-types'
import {
  asRecord,
  extractContentText,
  extractGitBranch,
  extractModel,
  extractString,
  normalizeCodexUsage,
  normalizeTitleText,
  parseJsonObject,
  subtractCodexUsage
} from './session-scanner-values'

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

type CodexSessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const codexSessionIndexTitleCache = new Map<string, Promise<CodexSessionIndexTitleCacheEntry>>()

export async function parseCodexSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  codexHome: string | null = null
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'codex',
    file,
    sessionId: sessionIdFromFileName(file.path)
  })
  let previousTotals: CodexUsageSnapshot | null = null

  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }

    updateTimeline(accumulator, extractString(record.timestamp))

    const payload = asRecord(record.payload)
    if (record.type === 'session_meta' && payload) {
      if (isCodexWorkerSession(payload)) {
        // Why: Codex writes internal worker/sub-agent transcripts into the same
        // history tree; AI Vault should show user-started sessions only.
        return null
      }
      const sessionId = extractString(payload.id)
      if (sessionId) {
        accumulator.sessionId = sessionId
      }
      const indexedTitle =
        extractCodexSessionMetadataTitle(payload) ??
        (await readCodexSessionIndexTitle(file.path, codexHome, accumulator.sessionId))
      if (indexedTitle) {
        accumulator.title = indexedTitle
      }
      const cwd = extractString(payload.cwd)
      if (cwd) {
        accumulator.cwd = cwd
      }
      accumulator.branch = extractGitBranch(payload.git) ?? accumulator.branch
      continue
    }

    if (record.type === 'turn_context' && payload) {
      const cwd = extractString(payload.cwd)
      if (cwd) {
        accumulator.cwd = cwd
      }
      const model = extractModel(payload)
      if (model) {
        accumulator.model = model
      }
      continue
    }

    if (!payload) {
      continue
    }

    if (record.type === 'response_item' && payload.type === 'message') {
      accumulator.messageCount++
      if (payload.role === 'user' && !accumulator.title) {
        accumulator.title = extractContentText(payload.content)
      }
      addPreviewContent(
        accumulator,
        payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'unknown',
        payload.content,
        record.timestamp
      )
      continue
    }

    if (record.type !== 'event_msg') {
      continue
    }

    if (payload.type === 'user_message') {
      accumulator.messageCount++
      if (!accumulator.title) {
        accumulator.title = extractContentText(payload.message)
      }
      addPreviewContent(accumulator, 'user', payload.message, record.timestamp)
      continue
    }

    if (payload.type === 'agent_message') {
      accumulator.messageCount++
      addPreviewContent(accumulator, 'assistant', payload.message, record.timestamp)
      continue
    }

    if (payload.type !== 'token_count') {
      continue
    }

    const info = asRecord(payload.info)
    if (!info) {
      continue
    }
    const totalUsage = normalizeCodexUsage(info.total_token_usage)
    const lastUsage = normalizeCodexUsage(info.last_token_usage)
    let delta: CodexUsageSnapshot | null = null
    if (totalUsage) {
      delta = subtractCodexUsage(totalUsage, previousTotals)
      previousTotals = totalUsage
    } else if (lastUsage) {
      delta = lastUsage
      previousTotals = previousTotals ? addCodexUsage(previousTotals, lastUsage) : lastUsage
    }
    if (delta) {
      accumulator.totalTokens += delta.totalTokens
    }
    const model = extractModel(payload)
    if (model) {
      accumulator.model = model
    }
  }

  return finalizeSession(accumulator, platform, { codexHome })
}

function addCodexUsage(
  base: CodexUsageSnapshot,
  increment: CodexUsageSnapshot
): CodexUsageSnapshot {
  return {
    inputTokens: base.inputTokens + increment.inputTokens,
    cachedInputTokens: base.cachedInputTokens + increment.cachedInputTokens,
    outputTokens: base.outputTokens + increment.outputTokens,
    reasoningOutputTokens: base.reasoningOutputTokens + increment.reasoningOutputTokens,
    totalTokens: base.totalTokens + increment.totalTokens
  }
}

function extractCodexThreadSource(payload: Record<string, unknown>): string | null {
  return extractString(payload.thread_source) ?? extractString(payload.threadSource)
}

function isCodexWorkerSession(payload: Record<string, unknown>): boolean {
  const threadSource = extractCodexThreadSource(payload)
  if (threadSource) {
    return threadSource.toLowerCase() !== 'user'
  }

  const source = asRecord(payload.source)
  return Boolean(asRecord(source?.subagent))
}

function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}

async function readCodexSessionIndexTitle(
  sessionFilePath: string,
  codexHome: string | null,
  sessionId: string
): Promise<string | null> {
  const resolvedCodexHome = codexHome ?? codexHomeFromSessionFilePath(sessionFilePath)
  if (!resolvedCodexHome) {
    return null
  }
  const titleBySessionId = await readCodexSessionIndexTitles(resolvedCodexHome)
  return titleBySessionId.get(sessionId) ?? null
}

function codexHomeFromSessionFilePath(sessionFilePath: string): string | null {
  let currentDir = dirname(sessionFilePath)
  while (currentDir && dirname(currentDir) !== currentDir) {
    if (basename(currentDir) === 'sessions') {
      return dirname(currentDir)
    }
    currentDir = dirname(currentDir)
  }
  return null
}

async function readCodexSessionIndexTitles(codexHome: string): Promise<Map<string, string>> {
  const indexPath = join(codexHome, CODEX_SESSION_INDEX_FILE)
  let signature: string
  try {
    const indexStat = await stat(indexPath)
    signature = `${indexStat.size}:${indexStat.mtimeMs}`
  } catch {
    return new Map()
  }

  const cached = codexSessionIndexTitleCache.get(codexHome)
  if (cached) {
    const entry = await cached
    if (entry.signature === signature) {
      return entry.titles
    }
  }

  const pending = readCodexSessionIndexTitlesFromDisk(indexPath).then((titles) => ({
    signature,
    titles
  }))
  codexSessionIndexTitleCache.set(codexHome, pending)
  return (await pending).titles
}

async function readCodexSessionIndexTitlesFromDisk(
  indexPath: string
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    const lines = createInterface({
      input: createReadStream(indexPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch {
    // Codex creates the index opportunistically; older homes may only have raw transcripts.
  }
  return titleBySessionId
}
