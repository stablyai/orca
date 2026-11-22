import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Pressable, Text } from 'react-native'
import { Bell, ChevronRight } from 'lucide-react-native'
import type { AgentChildRowModel } from '../../../../../src/shared/agent-status/presentation/agent-child-row-model'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { flattenAgentRowLineage, type AgentRowNode } from '../agent-row-lineage'
import {
  collapsedChildrenSignalState,
  hidesUnreadAgent,
  isDisclosureOpen,
  partitionIdleChildren,
  toggleDisclosure
} from '../agent-child-disclosure'
import { agentDotState, agentStatePhrase } from '../agent-row-display'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import type { AgentListStatus as AgentDotState } from '../../../../../src/shared/agent-status/presentation/agent-list-status'
import { WorktreeAgentChildToggle, WorktreeAgentIdleGroupRow } from './WorktreeAgentChildDisclosure'
import { WorktreeAgentRow, type WorktreeAgentRowVariant } from './WorktreeAgentRow'
import { useSharedNow } from '../../../hooks/use-now'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { worktreeListRowStyles } from '../../row-presentation/worktree-list-row-styles'
import { worktreeAgentChildRows } from '../worktree-agent-child-rows'

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  unvisited: boolean
  statusLive?: boolean
  isReadOnly?: boolean
  onAgentPress?: (paneKey: string) => void
  onAgentLongPress?: () => void
  /** The desktop's "Full list" agent activity layout: every agent's last message, nothing folded. */
  fullList?: boolean
  /** The workspace's terminal count ("2 terminals"), said after a lone agent. */
  terminals?: string
}

// Enough agents to scan at a glance; the rest fold behind one line.
const MAX_VISIBLE_AGENTS = 3

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
  terminals
}: Props) {
  const t = useMobileTranslation()
  // Only lists that draw agent times tick, so the rest of the host list skips the 30 s clock.
  const now = useSharedNow(30_000)
  const roots = useMemo(
    () => flattenAgentRowLineage(agents).filter((node) => node.depth === 0),
    [agents]
  )
  const [expanded, setExpanded] = useState(false)
  // Disclosure state lives in a module cache; this counter only re-renders after a toggle.
  const [, setDisclosureRevision] = useState(0)
  const toggle = useCallback((key: string) => {
    toggleDisclosure(key)
    setDisclosureRevision((revision) => revision + 1)
  }, [])

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
      onLongPress={onAgentLongPress}
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

  const renderNode = (
    node: AgentRowNode,
    variant: WorktreeAgentRowVariant = 'message',
    suffix?: string
  ): ReactNode => {
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
          isReadOnly={isReadOnly}
          onPress={onAgentPress}
          onLongPress={onAgentLongPress}
          variant={variant}
          suffix={suffix}
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

  const lone = roots.length === 1 ? roots[0] : null
  const lonePhrase =
    lone && !fullList
      ? agentStatePhrase(formatAgentTypeLabel(lone.row.agentType), agentDotState(lone.row, now))
      : null
  if (lone && lonePhrase) {
    return renderNode(lone, 'phrase', terminals)
  }
  const folded = !fullList && !expanded && roots.length > MAX_VISIBLE_AGENTS
  const shown = folded ? roots.slice(0, MAX_VISIBLE_AGENTS) : roots
  const hidden = roots.length - shown.length
  const detail =
    roots.length > 1
      ? t('components.worktreeListRow.agentCount', '{{count}} agents', { count: roots.length })
      : terminals
  const moreLabel = t('components.worktreeAgentList.showMoreAgents', 'Show {{count}} more', {
    count: hidden
  })
  const hidesUnreadRoot = folded && hidesUnreadAgent(roots.slice(shown.length).map((n) => n.row))
  return (
    <>
      {detail ? (
        <Text style={worktreeListRowStyles.detail} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {shown.map((node) => renderNode(node, fullList ? 'message' : 'state'))}
      {folded ? (
        <Pressable
          style={({ pressed }) => [worktreeListRowStyles.moreAgents, pressed && pressedStyle]}
          hitSlop={MORE_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={
            hidesUnreadRoot ? `${moreLabel}, ${t('agents.list.unread', 'Unread')}` : moreLabel
          }
          accessibilityState={{ expanded: false }}
          onPress={(event) => {
            event.stopPropagation()
            setExpanded(true)
          }}
        >
          <Text style={worktreeListRowStyles.moreAgentsText}>{moreLabel}</Text>
          {hidesUnreadRoot ? (
            <Bell size={12} color={colors.statusAmber} fill={colors.statusAmber} />
          ) : null}
          <ChevronRight size={14} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </>
  )
}

const MORE_HIT_SLOP = { top: 7, bottom: 7 } as const
