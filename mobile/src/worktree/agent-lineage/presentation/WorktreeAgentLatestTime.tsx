import { Text } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { useSharedNow } from '../../../hooks/use-now'
import { agentRowTimeAt, formatTimeAgo } from '../agent-row-display'
import { worktreeListRowStyles } from '../../row-presentation/worktree-list-row-styles'

/** When the workspace's agents last changed state, on its title line. */
export function WorktreeAgentLatestTime({
  agents
}: {
  agents: readonly RuntimeWorktreeAgentRow[]
}) {
  const now = useSharedNow(30_000)
  const latest = Math.max(...agents.map(agentRowTimeAt))
  return latest > 0 ? (
    <Text style={worktreeListRowStyles.time}>{formatTimeAgo(latest, now)}</Text>
  ) : null
}
