import { Fragment, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { buildAgentRowLineageTree, flattenAgentRowLineage } from '../worktree/agent-row-lineage'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { WorktreeAgentSummary } from './WorktreeAgentSummary'
import { worktreeAgentChildRows } from '../worktree/worktree-agent-child-rows'

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  now: number
  unvisited: boolean
  statusLive?: boolean
  hostClockOffsetMs?: number
  isReadOnly?: boolean
  onAgentPress?: (paneKey: string) => void
}

// Inline agent list for one worktree row: flattens the spawn lineage and renders
// a depth-indented WorktreeAgentRow per agent, mirroring the desktop sidebar's
// WorktreeCardAgents.
export function WorktreeAgentList({
  agents,
  now,
  unvisited,
  statusLive = false,
  hostClockOffsetMs,
  isReadOnly = false,
  onAgentPress
}: Props) {
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
        ? nodes.map((node) => {
            const children = worktreeAgentChildRows(node.row, now, statusLive, hostClockOffsetMs)
            return (
              <Fragment key={node.row.paneKey}>
                <WorktreeAgentRow
                  agent={node.row}
                  depth={node.depth}
                  now={now}
                  unvisited={unvisited}
                />
                {children.rows.map((childRow) => (
                  <WorktreeAgentRow
                    key={childRow.id}
                    agent={node.row}
                    childRow={childRow}
                    depth={node.depth + 1}
                    now={now}
                    elapsedNow={children.elapsedNow}
                    unvisited={unvisited}
                    isReadOnly={isReadOnly}
                    onPress={onAgentPress}
                  />
                ))}
              </Fragment>
            )
          })
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    marginTop: 3
  }
})
