import type { AiVaultSession } from '../../shared/ai-vault-types'
import { normalizeTitleText, parseJsonObject, timestampMs } from './session-scanner-values'

const HISTORY_MATCH_WINDOW_MS = 2_000

type AntigravityHistoryEntry = {
  timestampMs: number
  workspace: string
}

type AntigravityHistoryIndex = Map<string, AntigravityHistoryEntry[]>

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
        index = readHistory(historyPath).then(indexAntigravityHistory)
        indexes.set(historyPath, index)
      }
      const workspace = findAntigravityWorkspace(session, await index)
      return workspace ? { ...session, cwd: workspace } : session
    }
  }
}

function indexAntigravityHistory(content: string | null): AntigravityHistoryIndex {
  const index: AntigravityHistoryIndex = new Map()
  for (const line of content?.split(/\r?\n/) ?? []) {
    const record = parseJsonObject(line)
    const display = typeof record?.display === 'string' ? normalizeTitleText(record.display) : null
    const workspace = typeof record?.workspace === 'string' ? record.workspace.trim() : ''
    const entryTimestampMs = timestampMs(record?.timestamp)
    if (!display || !workspace || !Number.isFinite(entryTimestampMs)) {
      continue
    }
    const entries = index.get(display) ?? []
    entries.push({ timestampMs: entryTimestampMs, workspace })
    index.set(display, entries)
  }
  return index
}

function findAntigravityWorkspace(
  session: AiVaultSession,
  index: AntigravityHistoryIndex
): string | null {
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
  const matches = (index.get(session.title) ?? []).filter(
    (entry) => Math.abs(entry.timestampMs - promptTimestampMs) <= HISTORY_MATCH_WINDOW_MS
  )
  // Why: history rows have no conversation id. A unique prompt/time match is
  // evidence for cwd; ambiguity must stay unknown instead of crossing projects.
  return matches.length === 1 ? (matches[0]?.workspace ?? null) : null
}
