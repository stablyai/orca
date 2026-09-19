import type { AiVaultSession } from '../../shared/ai-vault-types'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { normalizeTitleText, parseJsonObject, timestampMs } from './session-scanner-values'

const HISTORY_MATCH_WINDOW_MS = 2_000

/**
 * The local-scan `readHistory`; remote scans inject their own transport. A
 * missing or unreadable history file is genuinely "no enrichment", but a gate
 * refusal must propagate so the caller records a scan issue — degrading it to
 * null lists the session with a missing cwd and no retry signal, and the
 * resolver's memo relies on the rejection to evict rather than pin a stall.
 */
export async function readLocalAntigravityHistory(path: string): Promise<string | null> {
  try {
    return await wslGatedReadFile(path, 'utf-8', 'scan')
  } catch (error) {
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
  byConversationId: Map<string, AntigravityHistoryEntry>
  byDisplay: Map<string, AntigravityHistoryEntry[]>
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
          .then(indexAntigravityHistory)
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
  const index: AntigravityHistoryIndex = {
    byConversationId: new Map(),
    byDisplay: new Map()
  }
  for (const line of content?.split(/\r?\n/) ?? []) {
    const record = parseJsonObject(line)
    const display = typeof record?.display === 'string' ? normalizeTitleText(record.display) : null
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    const conversationId =
      typeof record?.conversationId === 'string' ? record.conversationId.trim() : ''
    const entryTimestampMs = timestampMs(record?.timestamp)
    if (!workspace || !Number.isFinite(entryTimestampMs)) {
      continue
    }
    const entry = { timestampMs: entryTimestampMs, workspace }
    const directEntry = index.byConversationId.get(conversationId)
    if (conversationId && (!directEntry || entryTimestampMs < directEntry.timestampMs)) {
      index.byConversationId.set(conversationId, entry)
    }
    if (!display) {
      continue
    }
    const entries = index.byDisplay.get(display) ?? []
    entries.push(entry)
    index.byDisplay.set(display, entries)
  }
  return index
}

function findAntigravityWorkspace(
  session: AiVaultSession,
  index: AntigravityHistoryIndex
): string | null {
  const directMatch = index.byConversationId.get(session.sessionId)
  if (directMatch) {
    return directMatch.workspace
  }
  // Why: truncated titles are not prompt identities; long worker prompts often
  // share the same 96-character prefix across unrelated workspaces.
  if (session.title.endsWith('...')) {
    return null
  }
  const firstTitledUserTimestamp = session.previewMessages.find(
    (message) => message.role === 'user' && normalizeTitleText(message.text) === session.title
  )?.timestamp
  const promptTimestampMs = timestampMs(firstTitledUserTimestamp ?? session.createdAt)
  if (!Number.isFinite(promptTimestampMs)) {
    return null
  }
  const matches = (index.byDisplay.get(session.title) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
  )
  // Why: legacy history rows have no conversation id. A unique prompt/time
  // match is evidence for cwd; ambiguity must stay unknown instead of crossing projects.
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}
