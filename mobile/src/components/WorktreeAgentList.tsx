import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  buildAgentRowLineageTree,
  flattenAgentRowLineage,
  type AgentRowNode
} from '../worktree/agent-row-lineage'
import {
  collapsedChildrenSignalState,
  partitionIdleChildren
} from '../worktree/agent-child-disclosure'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import { WorktreeAgentChildToggle, WorktreeAgentIdleGroupRow } from './WorktreeAgentChildDisclosure'
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

// A parent's direct children: its sub-agent rows, then its spawned lineage agents.
type ChildItem =
  | { kind: 'subagent'; key: string; dotState: AgentDotState; childRow: AgentChildRowModel }
  | { kind: 'agent'; key: string; dotState: AgentDotState; node: AgentRowNode }

function toggleKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}

const NO_KEYS: ReadonlySet<string> = new Set()

// Nest spawn lineage under its parent, matching desktop WorktreeCardAgents: children start collapsed.
export function WorktreeAgentList({
  agents,
  now,
  unvisited,
  statusLive = false,
  isReadOnly = false,
  onAgentPress,
  fullList = false
}: Props) {
  const roots = useMemo(
    () => flattenAgentRowLineage(agents).filter((node) => node.depth === 0),
    [agents]
  )
  const summaryAgents = useMemo(() => {
    const lineage = buildAgentRowLineageTree(agents)
    return lineage.childrenByParentPaneKey.size > 0 ? lineage.rootRows : agents
  }, [agents])
  const [expanded, setExpanded] = useState(false)
  const [expandedParents, setExpandedParents] = useState(NO_KEYS)
  const [expandedIdleGroups, setExpandedIdleGroups] = useState(NO_KEYS)
  const toggleParent = useCallback(
    (paneKey: string) => setExpandedParents((keys) => toggleKey(keys, paneKey)),
    []
  )
  const toggleIdleGroup = useCallback(
    (paneKey: string) => setExpandedIdleGroups((keys) => toggleKey(keys, paneKey)),
    []
  )
  const usesSummary = !fullList && summaryAgents.length > 1

  const renderSubagent = (node: AgentRowNode, childRow: AgentChildRowModel): ReactNode => (
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
  )

  const renderNode = (node: AgentRowNode): ReactNode => {
    const parentKey = node.row.paneKey
    const children: ChildItem[] = [
      ...worktreeAgentChildRows(node.row, statusLive).map((childRow): ChildItem => ({
        kind: 'subagent',
        key: childRow.id,
        dotState: childRow.displayState,
        childRow
      })),
      ...node.children.map((child): ChildItem => ({
        kind: 'agent',
        key: child.row.paneKey,
        dotState: agentDotState(child.row, now),
        node: child
      }))
    ]
    const childrenExpanded = expandedParents.has(parentKey)
    const renderChild = (child: ChildItem): ReactNode =>
      child.kind === 'subagent' ? renderSubagent(node, child.childRow) : renderNode(child.node)
    const { activeChildren, idleChildren } = partitionIdleChildren(children)
    const idleExpanded = expandedIdleGroups.has(parentKey)
    return (
      <Fragment key={parentKey}>
        <WorktreeAgentRow
          agent={node.row}
          depth={node.depth}
          now={now}
          unvisited={unvisited}
          trailing={
            children.length > 0 ? (
              <WorktreeAgentChildToggle
                count={children.length}
                expanded={childrenExpanded}
                signalState={childrenExpanded ? undefined : collapsedChildrenSignalState(children)}
                onToggle={() => toggleParent(parentKey)}
              />
            ) : undefined
          }
        />
        {childrenExpanded ? (
          <>
            {activeChildren.map(renderChild)}
            {idleChildren.length > 0 ? (
              <WorktreeAgentIdleGroupRow
                count={idleChildren.length}
                depth={node.depth + 1}
                expanded={idleExpanded}
                onToggle={() => toggleIdleGroup(parentKey)}
              />
            ) : null}
            {idleExpanded ? idleChildren.map(renderChild) : null}
          </>
        ) : null}
      </Fragment>
    )
  }

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
      {!usesSummary || expanded ? roots.map(renderNode) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: {
    marginTop: 3
  }
})
