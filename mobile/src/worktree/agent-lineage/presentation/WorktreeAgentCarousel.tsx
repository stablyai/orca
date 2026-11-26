import { memo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import { listedAgentVerdict } from '../../../agents/agent-list-rows'
import { AgentStateDot } from '../../../agents/presentation/AgentStateDot'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { agentDotState, agentStateLabel } from '../agent-row-display'
import { agentTileTitle } from '../agent-tile-title'
import { WorktreeAgentDetailsSheet } from './WorktreeAgentDetailsSheet'

export type CarouselAgent = {
  agent: RuntimeWorktreeAgentRow
  /** Sub-agents and spawned agents nested under this one. */
  childCount: number
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
  const detailsAgent = agents.find((item) => item.agent.paneKey === detailsPaneKey)?.agent ?? null
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        // Why: the strip sits inside a pressable workspace row; keep swipes from activating it.
        onTouchStart={(event) => event.stopPropagation()}
      >
        {agents.map(({ agent, childCount }) => (
          <AgentTile
            key={agent.paneKey}
            agent={agent}
            childCount={childCount}
            now={now}
            unvisited={unvisited}
            isReadOnly={isReadOnly}
            onPress={onAgentPress}
            onLongPress={setDetailsPaneKey}
          />
        ))}
      </ScrollView>
      <WorktreeAgentDetailsSheet
        agent={detailsAgent}
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
  now,
  unvisited,
  isReadOnly,
  onPress,
  onLongPress
}: {
  agent: RuntimeWorktreeAgentRow
  childCount: number
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
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, pressed && pressedStyle]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${formatAgentTypeLabel(agent.agentType)}. ${agentStateLabel(dotState)}`}
      accessibilityHint={t(
        'worktree.agentCarousel.holdHint',
        'Touch and hold to see the full name'
      )}
      // Why: a read-only host still lets you read names; only opening the agent is blocked.
      onPress={(event) => {
        event.stopPropagation()
        if (!isReadOnly) {
          onPress?.(agent.paneKey)
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
          <View style={styles.childBadge}>
            <Text style={styles.childBadgeText}>+{childCount}</Text>
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
  childBadge: {
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
