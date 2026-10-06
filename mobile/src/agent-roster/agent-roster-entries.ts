import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from '../worktree/workspace-list-types'

export type AgentRosterEntry = {
  key: string
  agent: RuntimeWorktreeAgentRow
  worktreeId: string
  worktreeLabel: string
  unvisited: boolean
}

// Mirrors the sidebar row's title (WorktreeListRow.tsx:137 `item.displayName || item.repo`) so a
// roster row and the workspace list never name the same worktree differently.
function worktreeLabel(worktree: Worktree): string {
  return worktree.displayName || worktree.repo
}

// paneKey is only unique within its worktree, and may be empty, so the worktree id has to scope it
// once two rows can collide.
function buildRosterKeys(rows: readonly { worktreeId: string; paneKey: string }[]): string[] {
  const occurrences = new Map<string, number>()
  for (const row of rows) {
    if (row.paneKey) {
      occurrences.set(row.paneKey, (occurrences.get(row.paneKey) ?? 0) + 1)
    }
  }
  const claimed = new Map<string, number>()
  return rows.map((row) => {
    const preferred =
      row.paneKey && occurrences.get(row.paneKey) === 1
        ? row.paneKey
        : `${row.worktreeId}:${row.paneKey}`
    const taken = claimed.get(preferred) ?? 0
    claimed.set(preferred, taken + 1)
    // Why: a duplicate the scope prefix cannot split (same paneKey twice in one worktree) still has
    // to get a distinct FlatList key.
    return taken === 0 ? preferred : `${preferred}#${taken}`
  })
}

// Recency first — the reason the page exists — then the state's own clock, then the key so the
// order is total and stable across renders.
function compareEntries(a: AgentRosterEntry, b: AgentRosterEntry): number {
  if (a.agent.updatedAt !== b.agent.updatedAt) {
    return b.agent.updatedAt - a.agent.updatedAt
  }
  if (a.agent.stateStartedAt !== b.agent.stateStartedAt) {
    return b.agent.stateStartedAt - a.agent.stateStartedAt
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

// The rows reach us as a salvaged member cast to Worktree, so `agents` can be any type the host
// sent — `?? []` alone would still let a non-array through into the for-of.
function rosterAgents(worktree: Worktree): RuntimeWorktreeAgentRow[] {
  return Array.isArray(worktree.agents) ? worktree.agents : []
}

/** Every worktree's agents, flattened into one activity-ordered list. */
export function buildAgentRosterEntries(worktrees: readonly Worktree[]): AgentRosterEntry[] {
  const flat: { worktree: Worktree; agent: RuntimeWorktreeAgentRow }[] = []
  for (const worktree of worktrees) {
    for (const agent of rosterAgents(worktree)) {
      flat.push({ worktree, agent })
    }
  }
  const keys = buildRosterKeys(
    flat.map(({ worktree, agent }) => ({
      worktreeId: worktree.worktreeId,
      paneKey: agent.paneKey
    }))
  )
  const entries = flat.map(({ worktree, agent }, index) => ({
    key: keys[index] ?? '',
    agent,
    worktreeId: worktree.worktreeId,
    worktreeLabel: worktreeLabel(worktree),
    unvisited: worktree.unread
  }))
  return entries.sort(compareEntries)
}
