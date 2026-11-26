import { memo, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { Bell } from 'lucide-react-native'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import { listedAgentVerdict } from '../../../agents/agent-list-rows'
import { AgentStateDot } from '../../../agents/presentation/AgentStateDot'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { agentDotState, agentStateLabel, type AgentDotState } from '../agent-row-display'
import { agentTileTitle } from '../agent-tile-title'
import { WorktreeAgentDetailsSheet } from './WorktreeAgentDetailsSheet'

/** An agent nested under a tile's agent: a sub-agent or a spawned agent, at any depth. */
export type NestedAgent = {
  key: string
  title: string
  /** What the agent is doing now, when the host reports it. */
  detail?: string
  dotState: AgentDotState
  /** 1 for a direct child, 2 for a grandchild, and so on. */
  depth: number
  /** The pane that opens it: its own, or its parent's for a sub-agent that has none. */
  openPaneKey: string
}

export type CarouselAgent = {
  agent: RuntimeWorktreeAgentRow
  /** Direct children, shown as the tile's +N badge. */
  childCount: number
  /** The most urgent state among every nested agent, so a waiting child still marks its tile. */
  childSignalState?: AgentDotState
  /** A nested agent the desktop holds unread. */
  childUnread: boolean
  /** Every nested agent, listed in the details sheet so each stays reachable. */
  nested: readonly NestedAgent[]
}

type Props = {
  agents: readonly CarouselAgent[]
  now: number
  unvisited: boolean
  isReadOnly?: boolean
  onAgentPress?: (paneKey: string) => void
  /** Opens the workspace actions that a long press on an agent row opened before. */
  onWorkspaceActions?: () => void
}

const NO_NESTED: readonly NestedAgent[] = []

// Expanded agent summary as a swipeable strip of square tiles: big targets, recognizable icons.
export function WorktreeAgentCarousel({
  agents,
  now,
  unvisited,
  isReadOnly = false,
  onAgentPress,
  onWorkspaceActions
}: Props) {
  const [detailsPaneKey, setDetailsPaneKey] = useState<string | null>(null)
  const details = agents.find((item) => item.agent.paneKey === detailsPaneKey) ?? null
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        // Why: the strip sits inside a pressable workspace row; keep swipes from activating it.
        onTouchStart={(event) => event.stopPropagation()}
      >
        {agents.map(({ agent, childCount, childSignalState, childUnread }) => (
          <AgentTile
            key={agent.paneKey}
            agent={agent}
            childCount={childCount}
            childSignalState={childSignalState}
            childUnread={childUnread}
            now={now}
            unvisited={unvisited}
            isReadOnly={isReadOnly}
            onPress={onAgentPress}
            onLongPress={setDetailsPaneKey}
          />
        ))}
      </ScrollView>
      <WorktreeAgentDetailsSheet
        agent={details?.agent ?? null}
        nested={details?.nested ?? NO_NESTED}
        now={now}
        onClose={() => setDetailsPaneKey(null)}
        onOpenAgent={isReadOnly ? undefined : onAgentPress}
        onWorkspaceActions={onWorkspaceActions}
      />
    </>
  )
}

const AgentTile = memo(function AgentTile({
  agent,
  childCount,
  childSignalState,
  childUnread,
  now,
  unvisited,
  isReadOnly,
  onPress,
  onLongPress
}: {
  agent: RuntimeWorktreeAgentRow
  childCount: number
  childSignalState?: AgentDotState
  childUnread: boolean
  now: number
  unvisited: boolean
  isReadOnly: boolean
  onPress?: (paneKey: string) => void
  onLongPress: (paneKey: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const dotState = agentDotState(agent, now)
  const title = agentTileTitle(agent, now)
  const needsYou = listedAgentVerdict(agent)?.unread === true
  const showDetailsLabel = t('worktree.agentCarousel.showDetails', 'Show details')
  const [detailsFocused, setDetailsFocused] = useState(false)
  return (
    <View style={styles.tileFrame}>
      <Pressable
        style={({ pressed }) => [styles.tile, pressed && pressedStyle]}
        accessibilityRole="button"
        accessibilityLabel={[
          title,
          formatAgentTypeLabel(agent.agentType),
          agentStateLabel(dotState),
          childCount > 0
            ? t('worktree.agentCarousel.subAgentCount', 'Sub-agents: {{count}}', {
                count: childCount
              })
            : null,
          childSignalState
            ? t('worktree.agentCarousel.subAgentState', 'A sub-agent is {{state}}', {
                state: agentStateLabel(childSignalState).toLowerCase()
              })
            : null,
          childUnread ? t('agents.list.unread', 'Unread') : null
        ]
          .filter(Boolean)
          .join('. ')}
        accessibilityHint={t(
          'worktree.agentCarousel.holdHint',
          'Touch and hold for details and sub-agents'
        )}
        // Same action screen readers reach through the long-press rows elsewhere in the app.
        accessibilityActions={[{ name: 'longpress', label: showDetailsLabel }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') {
            onLongPress(agent.paneKey)
          }
        }}
        // Why: a read-only host cannot open the agent, so a press opens its details instead; that also
        // gives keyboard users a route to the sheet and the workspace actions it holds.
        onPress={(event) => {
          event.stopPropagation()
          if (isReadOnly || !onPress) {
            onLongPress(agent.paneKey)
          } else {
            onPress(agent.paneKey)
          }
        }}
        onLongPress={(event) => {
          event.stopPropagation()
          onLongPress(agent.paneKey)
        }}
        delayLongPress={400}
      >
        <View style={styles.square}>
          {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={24} /> : null}
          <View style={styles.dot}>
            <AgentStateDot state={dotState} />
          </View>
          {childCount > 0 ? (
            // Mirrors the old collapsed child toggle: the hidden children's most urgent state and unread.
            <View style={styles.childBadge}>
              {childSignalState ? <AgentStateDot state={childSignalState} decorative /> : null}
              <Text style={styles.childBadgeText}>+{childCount}</Text>
              {childUnread ? (
                <Bell size={9} color={colors.statusAmber} fill={colors.statusAmber} />
              ) : null}
            </View>
          ) : null}
        </View>
        <Text
          style={[styles.title, (unvisited || needsYou) && styles.titleEmphasis]}
          numberOfLines={2}
        >
          {title}
        </Text>
      </Pressable>
      {Platform.OS === 'web' ? (
        // Why: a web keyboard has no long press, and Enter on the tile opens the agent. This
        // control is the Tab stop for the details sheet; it stays invisible until it has focus.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${showDetailsLabel}: ${title}`}
          style={[styles.detailsButton, !detailsFocused && styles.detailsButtonHidden]}
          onFocus={() => setDetailsFocused(true)}
          onBlur={() => setDetailsFocused(false)}
          onPress={(event) => {
            event.stopPropagation()
            onLongPress(agent.paneKey)
          }}
        >
          <Text style={styles.detailsButtonText}>{showDetailsLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
})

const TILE_SIZE = 48

const styles = themedStyleSheet(() => ({
  strip: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    paddingRight: spacing.sm
  },
  tile: {
    width: 68,
    alignItems: 'center',
    gap: spacing.xs
  },
  square: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: {
    position: 'absolute',
    top: -4,
    right: -4
  },
  tileFrame: {
    position: 'relative'
  },
  detailsButton: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingVertical: 2,
    borderRadius: radii.mark,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  // Still reachable with Tab, but out of the way of mouse clicks on the tile below it.
  detailsButtonHidden: {
    opacity: 0,
    pointerEvents: 'none'
  },
  detailsButtonText: {
    fontSize: 10,
    color: colors.textPrimary
  },
  childBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    position: 'absolute',
    bottom: -5,
    right: -6,
    paddingHorizontal: 3,
    borderRadius: radii.mark,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  childBadgeText: {
    fontSize: 10,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  title: {
    width: '100%',
    // Two lines are always reserved so tiles stay aligned whatever the name length.
    minHeight: 28,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
    color: colors.textMuted
  },
  titleEmphasis: {
    color: colors.textPrimary,
    fontWeight: '600'
  }
}))
