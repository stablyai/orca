import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentChildRowModel } from '../../../src/shared/agent-status/presentation/agent-child-row-model'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { SubagentDisplayMode } from '../../../src/shared/ui-chrome-types'
import {
  buildAgentRowLineageTree,
  flattenAgentRowLineage,
  type AgentRowNode
} from '../worktree/agent-row-lineage'
import {
  collapsedChildrenSignalState,
  isDisclosureOpen,
  partitionIdleChildren,
  toggleDisclosure
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
  onAgentLongPress?: () => void
  /** The desktop's "Full list" agent activity layout: every row, no summary. */
  fullList?: boolean
  showSubagents?: boolean
  subagentDisplayMode?: SubagentDisplayMode
}

// A parent's direct children: its sub-agent rows, then its spawned lineage agents.
type ChildItem =
  | { kind: 'subagent'; key: string; dotState: AgentDotState; childRow: AgentChildRowModel }
  | { kind: 'agent'; key: string; dotState: AgentDotState; node: AgentRowNode }

// Pane keys are globally unique, so disclosure keys need no worktree prefix.
const parentDisclosureKey = (paneKey: string) => `parent:${paneKey}`
const idleDisclosureKey = (paneKey: string) => `idle:${paneKey}`

function summaryStateForChildRow(childRow: AgentChildRowModel): RuntimeWorktreeAgentRow['state'] {
  if (childRow.displayState === 'waiting' || childRow.displayState === 'blocked') {
    return childRow.displayState
  }
  if (
    childRow.displayState === 'done' ||
    childRow.displayState === 'failed' ||
    childRow.displayState === 'interrupted'
  ) {
    return 'done'
  }
  return 'working'
}

// Nest spawn lineage under its parent, matching desktop WorktreeCardAgents: children start collapsed.
export function WorktreeAgentList({
  agents,
  now,
  unvisited,
  statusLive = false,
  isReadOnly = false,
  onAgentPress,
  onAgentLongPress,
  fullList = false,
  showSubagents = true,
  subagentDisplayMode = 'tree'
}: Props) {
  const roots = useMemo(
    () => flattenAgentRowLineage(agents).filter((node) => node.depth === 0),
    [agents]
  )
  const subagentsOf = useCallback(
    (row: RuntimeWorktreeAgentRow): AgentChildRowModel[] =>
      showSubagents ? worktreeAgentChildRows(row, statusLive) : [],
    [showSubagents, statusLive]
  )
  const summaryAgents = useMemo(() => {
    const lineage = buildAgentRowLineageTree(agents)
    const base = lineage.childrenByParentPaneKey.size > 0 ? lineage.rootRows : agents
    if (!showSubagents || subagentDisplayMode !== 'flat') {
      return base
    }
    return base.flatMap((row) => [
      row,
      ...worktreeAgentChildRows(row, statusLive).map((childRow): RuntimeWorktreeAgentRow => ({
        ...row,
        paneKey: `${row.paneKey}\0subagent:${childRow.id}`,
        state: summaryStateForChildRow(childRow)
      }))
    ])
  }, [agents, showSubagents, statusLive, subagentDisplayMode])
  const [expanded, setExpanded] = useState(false)
  // Disclosure state lives in a module cache; this counter only re-renders after a toggle.
  const [, setDisclosureRevision] = useState(0)
  const toggle = useCallback((key: string) => {
    toggleDisclosure(key)
    setDisclosureRevision((revision) => revision + 1)
  }, [])
  const usesSummary = !fullList && summaryAgents.length > 1
  const flatSubagents = showSubagents && subagentDisplayMode === 'flat'

  const renderSubagent = (
    node: AgentRowNode,
    childRow: AgentChildRowModel,
    depth: number
  ): ReactNode => (
    <WorktreeAgentRow
      key={childRow.id}
      agent={node.row}
      childRow={childRow}
      depth={depth}
      now={now}
      unvisited={unvisited}
      isReadOnly={isReadOnly}
      onPress={onAgentPress}
      onLongPress={onAgentLongPress}
    />
  )

  const childItemsOf = (node: AgentRowNode): ChildItem[] => [
    ...(flatSubagents
      ? []
      : subagentsOf(node.row).map((childRow): ChildItem => ({
          kind: 'subagent',
          key: childRow.id,
          dotState: childRow.displayState,
          childRow
        }))),
    ...node.children.map((child): ChildItem => ({
      kind: 'agent',
      key: child.row.paneKey,
      dotState: agentDotState(child.row, now),
      node: child
    }))
  ]
  // A waiting grandchild must still light a collapsed ancestor; flattenAgentRowLineage already breaks cycles.
  const descendantItemsOf = (node: AgentRowNode): ChildItem[] =>
    childItemsOf(node).flatMap((child) =>
      child.kind === 'agent' ? [child, ...descendantItemsOf(child.node)] : [child]
    )

  const renderNode = (node: AgentRowNode): ReactNode => {
    const parentKey = node.row.paneKey
    const children = childItemsOf(node)
    const promotedSubagents = flatSubagents ? subagentsOf(node.row) : []
    const childrenExpanded = isDisclosureOpen(parentDisclosureKey(parentKey))
    const renderChild = (child: ChildItem): ReactNode =>
      child.kind === 'subagent'
        ? renderSubagent(node, child.childRow, node.depth + 1)
        : renderNode(child.node)
    const { activeChildren, idleChildren } = partitionIdleChildren(children)
    const idleExpanded = isDisclosureOpen(idleDisclosureKey(parentKey))
    return (
      <Fragment key={parentKey}>
        <WorktreeAgentRow
          agent={node.row}
          depth={node.depth}
          now={now}
          unvisited={unvisited}
          isReadOnly={isReadOnly}
          onPress={onAgentPress}
          onLongPress={onAgentLongPress}
          trailing={
            children.length > 0 ? (
              <WorktreeAgentChildToggle
                count={children.length}
                expanded={childrenExpanded}
                signalState={
                  childrenExpanded
                    ? undefined
                    : collapsedChildrenSignalState(descendantItemsOf(node))
                }
                onToggle={() => toggle(parentDisclosureKey(parentKey))}
              />
            ) : undefined
          }
        />
        {promotedSubagents.map((childRow) => renderSubagent(node, childRow, node.depth))}
        {childrenExpanded ? (
          <>
            {activeChildren.map(renderChild)}
            {idleChildren.length > 0 ? (
              <WorktreeAgentIdleGroupRow
                count={idleChildren.length}
                depth={node.depth + 1}
                expanded={idleExpanded}
                onToggle={() => toggle(idleDisclosureKey(parentKey))}
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
