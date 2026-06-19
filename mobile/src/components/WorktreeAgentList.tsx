import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { flattenAgentRowLineage } from '../worktree/agent-row-lineage'
import { WorktreeAgentRow } from './WorktreeAgentRow'

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  now: number
  unvisited: boolean
}

// Inline agent list for one worktree row: flattens the spawn lineage and renders
// a depth-indented WorktreeAgentRow per agent, mirroring the desktop sidebar's
// WorktreeCardAgents.
export function WorktreeAgentList({ agents, now, unvisited }: Props) {
  // Why: rebuild the lineage tree only when the agent list changes, not on every
  // re-render (the shared useNow tick re-renders this list every 30s).
  const nodes = useMemo(() => flattenAgentRowLineage(agents), [agents])
  return (
    <View style={styles.list}>
      {nodes.map((node) => (
        <WorktreeAgentRow
          key={node.row.paneKey}
          agent={node.row}
          depth={node.depth}
          now={now}
          unvisited={unvisited}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    marginTop: 3
  }
})
