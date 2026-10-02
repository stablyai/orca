import type { AiVaultSession } from '../../shared/ai-vault-types'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import {
  extractString,
  normalizeFullFirstUserPromptText,
  normalizeTitleText,
  parseJsonObject,
  shouldCaptureFullFirstUserPrompt,
  timestampMs
} from './session-scanner-values'

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
  byConversationId: Map<string, string>
  byFullPrompt: Map<string, AntigravityHistoryEntry[]>
  byTitle: Map<string, AntigravityHistoryEntry[]>
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
      if (session.agent !== 'antigravity') {
        return session
      }
      let baseSession = session
      if (!session.cwd) {
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
        if (workspace) {
          baseSession = { ...session, cwd: workspace }
        }
      }
      // Why: list scans omit firstUserPrompt from IPC payloads; retain only for on-demand capture.
      if (shouldCaptureFullFirstUserPrompt()) {
        return baseSession
      }
      const { firstUserPrompt: _firstUserPrompt, ...cleanSession } = baseSession
      return cleanSession
    }
  }
}

function indexAntigravityHistory(content: string | null): AntigravityHistoryIndex {
  const index: AntigravityHistoryIndex = {
    byConversationId: new Map(),
    byFullPrompt: new Map(),
    byTitle: new Map()
  }
  for (const line of content?.split(/\r?\n/) ?? []) {
    const record = parseJsonObject(line)
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    if (!workspace) {
      continue
    }
    const conversationId =
      extractString(record?.conversationId) ??
      extractString(record?.conversation_id) ??
      extractString(record?.sessionId) ??
      extractString(record?.session_id)
    // Why: preserve the initial workspace if a session subsequently changed directories.
    if (conversationId && !index.byConversationId.has(conversationId)) {
      index.byConversationId.set(conversationId, workspace)
    }

    const entryTimestampMs = timestampMs(record?.timestamp)
    if (!Number.isFinite(entryTimestampMs)) {
      continue
    }

    if (typeof record?.display === 'string') {
      const fullPrompt = normalizeFullFirstUserPromptText(record.display)
      if (fullPrompt) {
        const fullEntries = index.byFullPrompt.get(fullPrompt) ?? []
        fullEntries.push({ timestampMs: entryTimestampMs, workspace })
        index.byFullPrompt.set(fullPrompt, fullEntries)
      }

      const display = normalizeTitleText(record.display)
      if (display) {
        const titleEntries = index.byTitle.get(display) ?? []
        titleEntries.push({ timestampMs: entryTimestampMs, workspace })
        index.byTitle.set(display, titleEntries)
      }
    }
  }
  return index
}

function findAntigravityWorkspace(
  session: AiVaultSession,
  index: AntigravityHistoryIndex
): string | null {
  // Why: conversation id is unambiguous evidence for cwd regardless of title truncation or turns.
  if (session.sessionId) {
    const workspace = index.byConversationId.get(session.sessionId)
    if (workspace) {
      return workspace
    }
  }

  const firstUserMessage = session.previewMessages.find((message) => message.role === 'user')
  const promptTimestampMs = timestampMs(firstUserMessage?.timestamp ?? session.createdAt)
  if (!Number.isFinite(promptTimestampMs)) {
    return null
  }

  // Why: untruncated prompt matching avoids collisions without dropping valid long prompts.
  if (session.firstUserPrompt) {
    const fullMatches = (index.byFullPrompt.get(session.firstUserPrompt) ?? []).filter(
      (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
    )
    if (fullMatches.length === 1) {
      return fullMatches[0]?.workspace ?? null
    }
    if (fullMatches.length > 1) {
      return null
    }
  }

  // Why: truncated titles are not prompt identities; long worker prompts often
  // share the same 96-character prefix across unrelated workspaces.
  if (session.title.endsWith('...')) {
    return null
  }
  const matches = (index.byTitle.get(session.title) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
  )
  // Why: history rows have no conversation id. A unique prompt/time match is
  // evidence for cwd; ambiguity must stay unknown instead of crossing projects.
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}
