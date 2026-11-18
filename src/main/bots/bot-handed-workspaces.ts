// The workspaces under a bot's home (handed to it, or made there by its workers): their agents work
// for the bot, so their approvals are in its Needs you.
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import {
  parseWorkspaceKey,
  type WorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'

/** The ids of the worktrees directly under each home, by home key. */
export function worktreesUnderHomes(
  lineage: Readonly<Record<WorkspaceKey, WorkspaceLineage>>,
  homeKeys: readonly string[]
): Map<string, Set<string>> {
  const homes = new Set(homeKeys)
  const under = new Map<string, Set<string>>()
  for (const record of Object.values(lineage)) {
    const child = parseWorkspaceKey(record.childWorkspaceKey)
    if (child?.type !== 'worktree' || !homes.has(record.parentWorkspaceKey)) {
      continue
    }
    const ids = under.get(record.parentWorkspaceKey) ?? new Set<string>()
    ids.add(child.worktreeId)
    under.set(record.parentWorkspaceKey, ids)
  }
  return under
}
