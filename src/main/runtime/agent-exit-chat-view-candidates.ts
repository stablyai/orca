import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-mobile-session-tab-contracts'
import { isComposerChatTarget } from '../../shared/native-chat-target-read'

/**
 * A pane whose agent exit must change what clients show: `owner` is the chat-owning pane of a chat
 * tab; `legacy` is the sole pane of a tab nobody switched (absent `viewMode`) whose launch hint
 * lets the phone show it as chat by its own default.
 */
export type AgentExitChatViewCandidate = {
  kind: 'owner' | 'legacy'
  worktreeId: string
  parentTabId: string
  leafId: string
  ptyId: string
  /** The published incarnation of the pane's PTY, when the host publishes it. */
  incarnationId: string | null
}

function chatTargetKind(
  row: RuntimeMobileSessionTerminalTab,
  leafIds: readonly string[]
): AgentExitChatViewCandidate['kind'] | null {
  if (
    !isComposerChatTarget({
      viewMode: row.viewMode,
      chatLeafId: row.parentLayout?.chatLeafId,
      launchAgent: row.launchAgent,
      leafIds,
      leafId: row.leafId
    })
  ) {
    return null
  }
  return row.viewMode === 'chat' ? 'owner' : 'legacy'
}

/** Re-derived from the published rows on every pass; nothing is stored between passes. */
export function collectAgentExitChatViewCandidates(
  snapshotsByWorktree: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>
): AgentExitChatViewCandidate[] {
  const candidates: AgentExitChatViewCandidate[] = []
  for (const [worktreeId, snapshot] of snapshotsByWorktree) {
    const rows = snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    const leafIdsByParent = new Map<string, string[]>()
    for (const row of rows) {
      leafIdsByParent.set(row.parentTabId, [
        ...(leafIdsByParent.get(row.parentTabId) ?? []),
        row.leafId
      ])
    }
    for (const row of rows) {
      if (!row.ptyId) {
        continue
      }
      // Why the published rows: this is only an index of candidates; every action re-reads truth.
      const kind = chatTargetKind(row, leafIdsByParent.get(row.parentTabId) ?? [])
      if (kind) {
        candidates.push({
          kind,
          worktreeId,
          parentTabId: row.parentTabId,
          leafId: row.leafId,
          ptyId: row.ptyId,
          incarnationId: row.incarnationId ?? null
        })
      }
    }
  }
  return candidates
}

/** The candidate rows a proven exit of `ptyId` affects, from the current publication. */
export function findAgentExitChatViewCandidatesForPty(
  snapshotsByWorktree: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>,
  ptyId: string
): AgentExitChatViewCandidate[] {
  return collectAgentExitChatViewCandidates(snapshotsByWorktree).filter(
    (candidate) => candidate.ptyId === ptyId
  )
}
