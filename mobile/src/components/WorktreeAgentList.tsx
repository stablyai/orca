import { Fragment, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { buildAgentRowLineageTree, flattenAgentRowLineage } from '../worktree/agent-row-lineage'
import { Collapsible } from './ui/Collapsible'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { WorktreeAgentSummary } from './WorktreeAgentSummary'
import { worktreeAgentChildRows } from '../worktree/worktree-agent-child-rows'

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  now: number
  unvisited: boolean
  statusLive?: boolean
  isReadOnly?: boolean
  onAgentPress?: (paneKey: string) => void
  /** The desktop's "Full list" agent activity layout: every row, no summary. */
  fullList?: boolean
}

// Inline agent list for one worktree row: flattens the spawn lineage and renders
// a depth-indented WorktreeAgentRow per agent, mirroring the desktop sidebar's
// WorktreeCardAgents.
export function WorktreeAgentList({
  agents,
  now,
  unvisited,
  statusLive = false,
  isReadOnly = false,
  onAgentPress,
  fullList = false
}: Props) {
  const nodes = useMemo(() => flattenAgentRowLineage(agents), [agents])
  const summaryAgents = useMemo(() => {
    const lineage = buildAgentRowLineageTree(agents)
    return lineage.childrenByParentPaneKey.size > 0 ? lineage.rootRows : agents
  }, [agents])
  const [expanded, setExpanded] = useState(false)
  const usesSummary = !fullList && summaryAgents.length > 1
  const rows = (
    <AgentRows
      nodes={nodes}
      now={now}
      unvisited={unvisited}
      statusLive={statusLive}
      isReadOnly={isReadOnly}
      onAgentPress={onAgentPress}
    />
  )

  if (!usesSummary) {
    return <View style={styles.list}>{rows}</View>
  }
  return (
    <View style={styles.list}>
      <WorktreeAgentSummary
        agents={summaryAgents}
        expanded={expanded}
        now={now}
        onToggle={() => setExpanded((value) => !value)}
      />
      <Collapsible open={expanded}>
        <View style={styles.rows}>{rows}</View>
      </Collapsible>
    </View>
  )
}

// Its own component, so a folded summary builds no rows until it opens.
function AgentRows({
  nodes,
  now,
  unvisited,
  statusLive,
  isReadOnly,
  onAgentPress
}: Pick<Props, 'now' | 'unvisited' | 'onAgentPress'> & {
  nodes: ReturnType<typeof flattenAgentRowLineage>
  statusLive: boolean
  isReadOnly: boolean
}) {
  return nodes.map((node) => {
    const children = worktreeAgentChildRows(node.row, statusLive)
    return (
      <Fragment key={node.row.paneKey}>
        <WorktreeAgentRow agent={node.row} depth={node.depth} now={now} unvisited={unvisited} />
        {children.map((childRow) => (
          <WorktreeAgentRow
            key={childRow.id}
            agent={node.row}
            childRow={childRow}
            depth={node.depth + 1}
            now={now}
            unvisited={unvisited}
            isReadOnly={isReadOnly}
            onPress={onAgentPress}
          />
        ))}
      </Fragment>
    )
  })
}

const styles = StyleSheet.create({
  list: {
    marginTop: 2,
    gap: 2
  },
  rows: {
    gap: 2
  }
})
