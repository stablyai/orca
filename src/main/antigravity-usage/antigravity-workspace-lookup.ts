import { join } from 'node:path'
import { antigravityHistoryPromptHash } from '../ai-vault/scanners/antigravity/antigravity-history-prompt'
import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  antigravityMetadataWorkspaces
} from '../ai-vault/scanners/antigravity/session-scanner-antigravity-metadata'
import { parseJsonObject } from '../ai-vault/parsing/session-json-object'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { AntigravityOpeningPrompt } from './types'

const HISTORY_MATCH_WINDOW_MS = 2_000
const MAX_HISTORY_LINES = 10_000
const ACP_META_MAX_BYTES = 64 * 1024

type HistoryPromptEntry = {
  timestampMs: number
  workspace: string
}

type AppDataWorkspaceIndex = {
  byId: Map<string, string | null>
  byPrompt: Map<string, HistoryPromptEntry[]>
  workspaceUriPathById: Map<string, string | null>
}

async function readBoundedUtf8(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const read = await readNodeFileWithinLimit(filePath, maxBytes, { regularFileOnly: true })
    return read.buffer.toString('utf8')
  } catch {
    return null
  }
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1e12 ? numeric : numeric * 1000
    }
    return Date.parse(value)
  }
  return Number.NaN
}

function recordUniqueWorkspace(
  target: Map<string, string | null>,
  id: string,
  workspace: string | null
): void {
  if (!target.has(id)) {
    target.set(id, workspace)
  } else if (target.get(id) !== workspace) {
    target.set(id, null)
  }
}

function indexHistoryContent(content: string | null): {
  byId: Map<string, string | null>
  byPrompt: Map<string, HistoryPromptEntry[]>
} {
  const byId = new Map<string, string | null>()
  const byPrompt = new Map<string, HistoryPromptEntry[]>()
  if (!content) {
    return { byId, byPrompt }
  }
  for (const line of content.split(/\r?\n/).slice(0, MAX_HISTORY_LINES)) {
    const record = parseJsonObject(line)
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    const timestampMs = parseTimestampMs(record?.timestamp)
    if (!workspace || workspace.length > 4096 || !Number.isFinite(timestampMs)) {
      continue
    }
    if (typeof record?.conversationId === 'string' && record.conversationId) {
      recordUniqueWorkspace(byId, record.conversationId, workspace)
    }
    const promptHash = antigravityHistoryPromptHash(record?.display)
    if (promptHash) {
      const list = byPrompt.get(promptHash) ?? []
      list.push({ timestampMs, workspace })
      byPrompt.set(promptHash, list)
    }
  }
  return { byId, byPrompt }
}

async function buildAppDataWorkspaceIndex(appDataDir: string): Promise<AppDataWorkspaceIndex> {
  const [history, metadata, projects, lastConversations] = await Promise.all([
    readBoundedUtf8(join(appDataDir, 'history.jsonl'), ANTIGRAVITY_INDEX_MAX_BYTES),
    readBoundedUtf8(
      join(appDataDir, 'cache', 'conversation_metadata.json'),
      ANTIGRAVITY_INDEX_MAX_BYTES
    ),
    readBoundedUtf8(join(appDataDir, 'cache', 'projects.json'), ANTIGRAVITY_INDEX_MAX_BYTES),
    readBoundedUtf8(
      join(appDataDir, 'cache', 'last_conversations.json'),
      ANTIGRAVITY_INDEX_MAX_BYTES
    )
  ])
  const indexed = indexHistoryContent(history)
  const cacheWorkspaces = antigravityMetadataWorkspaces({
    metadata,
    projects,
    lastConversations
  })
  for (const [id, path] of cacheWorkspaces.paths) {
    recordUniqueWorkspace(indexed.byId, id, path)
  }
  return {
    byId: indexed.byId,
    byPrompt: indexed.byPrompt,
    workspaceUriPathById: cacheWorkspaces.workspaceUriPathById
  }
}

function matchOpeningPrompt(
  opening: AntigravityOpeningPrompt | null,
  byPrompt: Map<string, HistoryPromptEntry[]>
): string | null {
  if (!opening) {
    return null
  }
  const promptTime = Date.parse(opening.timestamp)
  if (!Number.isFinite(promptTime)) {
    return null
  }
  const matches = (byPrompt.get(opening.hash) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTime) <= HISTORY_MATCH_WINDOW_MS
  )
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}

export type AntigravityWorkspaceLookup = {
  resolve(
    appDataDir: string,
    conversationId: string,
    openingPrompt: AntigravityOpeningPrompt | null
  ): Promise<string | null>
}

export function createAntigravityWorkspaceLookup(): AntigravityWorkspaceLookup {
  const indexByAppDataDir = new Map<string, Promise<AppDataWorkspaceIndex>>()

  const getIndex = (appDataDir: string): Promise<AppDataWorkspaceIndex> => {
    let pending = indexByAppDataDir.get(appDataDir)
    if (!pending) {
      pending = buildAppDataWorkspaceIndex(appDataDir)
      indexByAppDataDir.set(appDataDir, pending)
    }
    return pending
  }

  return {
    async resolve(appDataDir, conversationId, openingPrompt) {
      const metaText = await readBoundedUtf8(
        join(appDataDir, 'conversations', `${conversationId}.meta`),
        ACP_META_MAX_BYTES
      )
      const metaCwd = metaText ? parseJsonObject(metaText)?.cwd : undefined
      if (typeof metaCwd === 'string' && metaCwd.trim() && metaCwd.trim().length <= 4096) {
        return metaCwd.trim()
      }

      const index = await getIndex(appDataDir)
      if (index.byId.has(conversationId)) {
        return index.byId.get(conversationId) ?? null
      }
      return (
        matchOpeningPrompt(openingPrompt, index.byPrompt) ??
        index.workspaceUriPathById.get(conversationId) ??
        null
      )
    }
  }
}
