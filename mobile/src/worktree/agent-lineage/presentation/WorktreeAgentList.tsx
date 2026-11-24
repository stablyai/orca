import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentChildRowModel } from '../../../../../src/shared/agent-status/presentation/agent-child-row-model'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import {
  buildAgentRowLineageTree,
  flattenAgentRowLineage,
  type AgentRowNode
} from '../agent-row-lineage'
import {
  collapsedChildrenSignalState,
  hidesUnreadAgent,
  isDisclosureOpen,
  partitionIdleChildren,
  toggleDisclosure
} from '../agent-child-disclosure'
import { agentDotState } from '../agent-row-display'
import type { AgentListStatus as AgentDotState } from '../../../../../src/shared/agent-status/presentation/agent-list-status'
import { WorktreeAgentChildToggle, WorktreeAgentIdleGroupRow } from './WorktreeAgentChildDisclosure'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { WorktreeAgentSummary } from './WorktreeAgentSummary'
import { useSharedNow } from '../../../hooks/use-now'
import { worktreeAgentChildRows } from '../worktree-agent-child-rows'

function parentSessionPress(
  selectable: boolean,
  onAgentPress: ((paneKey: string) => void) | undefined,
  onLongPress: ((paneKey: string) => void) | undefined,
  onWorkspacePress: (() => void) | undefined
): ((paneKey: string) => void) | undefined {
  if (selectable && onAgentPress) {
    return onAgentPress
  }
  if (onLongPress) {
    return onWorkspacePress
  }
  // #37458: a plain row opens its own pane, not the workspace's active tab.
  return onAgentPress
}

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  unvisited: boolean
  statusLive?: boolean
  isReadOnly?: boolean
  onAgentPress?: (paneKey: string) => void
  /** Workspace menu when the row has no session hold. */
  onAgentLongPress?: () => void
  /** The desktop's "Full list" agent activity layout: every row, no summary. */
  fullList?: boolean
  /** Each session is its own taller target. Off, a long-press on the card still lists every session. */
  selectable?: boolean
  /** Pane open from a session tap. Only that session row is filled. */
  selectedPaneKey?: string | null
  onLongPress?: (paneKey: string) => void
  /** Tap on a session row while sessions are not selectable. Opens the workspace, not that session. */
  onWorkspacePress?: () => void
  onPressIn?: () => void
  onPressOut?: () => void
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
  unvisited,
  statusLive = false,
  isReadOnly = false,
  onAgentPress,
  onAgentLongPress,
  fullList = false,
  selectable = false,
  selectedPaneKey = null,
  onLongPress,
  onWorkspacePress,
  onPressIn,
  onPressOut
}: Props) {
  // Only lists that draw agent times tick, so the rest of the host list skips the 30 s clock.
  const now = useSharedNow(30_000)
  const hold = onLongPress ?? (onAgentLongPress ? () => onAgentLongPress() : undefined)
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
      selectable={selectable}
      isReadOnly={isReadOnly}
      onPress={onAgentPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onLongPress={hold}
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
  const withDescendants = (items: readonly ChildItem[]): ChildItem[] =>
    items.flatMap((child) =>
      child.kind === 'agent' ? [child, ...withDescendants(childItemsOf(child.node))] : [child]
    )
  const descendantItemsOf = (node: AgentRowNode): ChildItem[] => withDescendants(childItemsOf(node))
  const hidesUnread = (hidden: readonly ChildItem[]): boolean =>
    hidesUnreadAgent(hidden.flatMap((item) => (item.kind === 'agent' ? [item.node.row] : [])))

  const renderNode = (node: AgentRowNode): ReactNode => {
    const parentKey = node.row.paneKey
    const children = childItemsOf(node)
    const childrenExpanded = isDisclosureOpen(parentDisclosureKey(parentKey))
    const hiddenDescendants =
      children.length > 0 && !childrenExpanded ? descendantItemsOf(node) : null
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
          selectable={selectable}
          selected={selectedPaneKey === node.row.paneKey}
          isReadOnly={isReadOnly}
          onPress={parentSessionPress(selectable, onAgentPress, onLongPress, onWorkspacePress)}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          onLongPress={hold}
          trailing={
            children.length > 0 ? (
              <WorktreeAgentChildToggle
                count={children.length}
                expanded={childrenExpanded}
                signalState={
                  hiddenDescendants ? collapsedChildrenSignalState(hiddenDescendants) : undefined
                }
                unread={hiddenDescendants ? hidesUnread(hiddenDescendants) : false}
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
                unread={!idleExpanded && hidesUnread(withDescendants(idleChildren))}
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
          unread={hidesUnreadAgent(agents)}
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
