import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  antigravityCachePath,
  antigravityMetadataWorkspaces,
  readBoundedAntigravityIndex
} from './session-scanner-antigravity-metadata'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { isWslUncPath } from '../../shared/wsl-paths'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { parseJsonObject, timestampMs } from './session-scanner-values'
import { antigravityHistoryPromptHash } from './antigravity-history-prompt'

const HISTORY_MATCH_WINDOW_MS = 2_000

/**
 * The local-scan `readHistory`; remote scans inject their own transport. A
 * missing or unreadable history file is genuinely "no enrichment", but a gate
 * refusal must propagate so the caller records a scan issue — degrading it to
 * null lists the session with a missing cwd and no retry signal, and the
 * resolver's memo relies on the rejection to evict rather than pin a stall.
 */
export async function readLocalAntigravityHistory(
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(signal)
    if (!isWslUncPath(path)) {
      const read = await readNodeFileWithinLimit(path, ANTIGRAVITY_INDEX_MAX_BYTES, {
        regularFileOnly: true,
        signal
      })
      return read.buffer.toString('utf8')
    }
    const stats = await wslGatedStat(path, 'scan', signal)
    if (!stats.isFile() || stats.size > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return null
    }
    const input = openTranscriptReadStream(
      path,
      { end: ANTIGRAVITY_INDEX_MAX_BYTES },
      'scan',
      signal
    )
    try {
      return await readBoundedAntigravityIndex(input)
    } finally {
      input.destroy()
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
}

type AntigravityHistoryEntry = {
  timestampMs: number
  workspace: string
}

type AntigravityHistoryIndex = {
  byPrompt: Map<string, AntigravityHistoryEntry[]>
  byId: Map<string, string | null>
}

export type AntigravityWorkspaceResolver = {
  enrich(session: AiVaultSession, historyPath: string): Promise<AiVaultSession>
}

export function createAntigravityWorkspaceResolver(
  readHistory: (historyPath: string) => Promise<string | null>
): AntigravityWorkspaceResolver {
  const indexes = new Map<string, Promise<AntigravityHistoryIndex>>()

  return {
    async enrich(session, historyPath) {
      if (session.agent !== 'antigravity' || session.cwd) {
        return session
      }
      let index = indexes.get(historyPath)
      if (!index) {
        // Why: a read failure is transient (a stalled WSL distro refuses here),
        // so it must not be memoized — every later session under this history
        // file would inherit the rejection for the process lifetime.
        const pending: Promise<AntigravityHistoryIndex> = readHistory(historyPath)
          .then(async (history) => {
            const index = indexAntigravityHistory(history)
            const [metadata, projects, lastConversations] = await Promise.all(
              ['conversation_metadata.json', 'projects.json', 'last_conversations.json'].map(
                (name) => readHistory(antigravityCachePath(historyPath, name))
              )
            )
            const paths = antigravityMetadataWorkspaces({
              metadata: metadata ?? null,
              projects: projects ?? null,
              lastConversations: lastConversations ?? null
            })
            for (const [id, path] of paths) {
              if (!index.byId.has(id)) {
                index.byId.set(id, path)
              } else if (index.byId.get(id) !== path) {
                index.byId.set(id, null)
              }
            }
            return index
          })
          .catch((error: unknown) => {
            if (indexes.get(historyPath) === pending) {
              indexes.delete(historyPath)
            }
            throw error
          })
        index = pending
        indexes.set(historyPath, pending)
      }
      const workspace = findAntigravityWorkspace(session, await index)
      return workspace ? { ...session, cwd: workspace } : session
    }
  }
}

function indexAntigravityHistory(content: string | null): AntigravityHistoryIndex {
  const index: AntigravityHistoryIndex = { byPrompt: new Map(), byId: new Map() }
  if (content && Buffer.byteLength(content) > ANTIGRAVITY_INDEX_MAX_BYTES) {
    return index
  }
  for (const line of content?.split(/\r?\n/).slice(0, 10_000) ?? []) {
    const record = parseJsonObject(line)
    const promptHash = antigravityHistoryPromptHash(record?.display)
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    const entryTimestampMs = timestampMs(record?.timestamp)
    const id = typeof record?.conversationId === 'string' ? record.conversationId : null
    if (!workspace || workspace.length > 4096 || !Number.isFinite(entryTimestampMs)) {
      continue
    }
    if (id) {
      if (!index.byId.has(id)) {
        index.byId.set(id, workspace)
      } else if (index.byId.get(id) !== workspace) {
        index.byId.set(id, null)
      }
    }
    if (!promptHash) {
      continue
    }
    const entries = index.byPrompt.get(promptHash) ?? []
    entries.push({ timestampMs: entryTimestampMs, workspace })
    index.byPrompt.set(promptHash, entries)
  }
  return index
}

function findAntigravityWorkspace(
  session: AiVaultSession,
  index: AntigravityHistoryIndex
): string | null {
  if (index.byId.has(session.sessionId)) {
    return index.byId.get(session.sessionId) ?? null
  }
  const opening = session.antigravityOpeningPrompt
  const promptTimestampMs = timestampMs(opening?.timestamp)
  // Titles, createdAt and rolling previews cannot identify the original prompt.
  if (!opening || !Number.isFinite(promptTimestampMs)) {
    return null
  }
  const matches = (index.byPrompt.get(opening.hash) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
  )
  // Exact prompt/time fallback is valid only when a single history row matches.
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}
