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
  /** The desktop's "Full list" agent activity layout: every row, no summary. */
  fullList?: boolean
}

// A parent's direct children: its sub-agent rows, then its spawned lineage agents.
type ChildItem =
  | { kind: 'subagent'; key: string; dotState: AgentDotState; childRow: AgentChildRowModel }
  | { kind: 'agent'; key: string; dotState: AgentDotState; node: AgentRowNode }

// Pane keys are globally unique, so disclosure keys need no worktree prefix.
const parentDisclosureKey = (paneKey: string) => `parent:${paneKey}`
const idleDisclosureKey = (paneKey: string) => `idle:${paneKey}`

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
  // Disclosure state lives in a module cache; this counter only re-renders after a toggle.
  const [, setDisclosureRevision] = useState(0)
  const toggle = useCallback((key: string) => {
    toggleDisclosure(key)
    setDisclosureRevision((revision) => revision + 1)
  }, [])
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

  const childItemsOf = (node: AgentRowNode): ChildItem[] => [
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
  // A waiting grandchild must still light a collapsed ancestor; flattenAgentRowLineage already breaks cycles.
  const descendantItemsOf = (node: AgentRowNode): ChildItem[] =>
    childItemsOf(node).flatMap((child) =>
      child.kind === 'agent' ? [child, ...descendantItemsOf(child.node)] : [child]
    )

  const renderNode = (node: AgentRowNode): ReactNode => {
    const parentKey = node.row.paneKey
    const children = childItemsOf(node)
    const childrenExpanded = isDisclosureOpen(parentDisclosureKey(parentKey))
    const renderChild = (child: ChildItem): ReactNode =>
      child.kind === 'subagent' ? renderSubagent(node, child.childRow) : renderNode(child.node)
    const { activeChildren, idleChildren } = partitionIdleChildren(children)
    const idleExpanded = isDisclosureOpen(idleDisclosureKey(parentKey))
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
