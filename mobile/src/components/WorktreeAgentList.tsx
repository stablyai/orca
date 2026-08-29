import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { buildAgentRowLineageTree, flattenAgentRowLineage } from '../worktree/agent-row-lineage'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { WorktreeAgentSummary } from './WorktreeAgentSummary'

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  now: number
  unvisited: boolean
}

// Inline agent list for one worktree row: flattens the spawn lineage and renders
// a depth-indented WorktreeAgentRow per agent, mirroring the desktop sidebar's
// WorktreeCardAgents.
export function WorktreeAgentList({ agents, now, unvisited }: Props) {
  const nodes = useMemo(() => flattenAgentRowLineage(agents), [agents])
  const summaryAgents = useMemo(() => {
    const lineage = buildAgentRowLineageTree(agents)
    return lineage.childrenByParentPaneKey.size > 0 ? lineage.rootRows : agents
  }, [agents])
  const [expanded, setExpanded] = useState(false)
  const usesSummary = summaryAgents.length > 1

  return (
    <View style={styles.list}>
      {usesSummary ? (
        <WorktreeAgentSummary
          agents={summaryAgents}
          expanded={expanded}
          now={now}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}
      {!usesSummary || expanded
        ? nodes.map((node) => (
            <WorktreeAgentRow
              key={node.row.paneKey}
              agent={node.row}
              depth={node.depth}
              now={now}
              unvisited={unvisited}
            />
          ))
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    marginTop: 3
  }
})
