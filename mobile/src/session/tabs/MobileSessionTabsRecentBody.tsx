import { useMemo, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Bell, File, FileText, Globe, Minus, Plus, SquareTerminal } from 'lucide-react-native'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { ListGroup } from '../../components/list/ListGroup'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { agentStateLabel, formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { getWorktreeLabel } from '../../worktree/row-presentation/worktree-label'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { formatWorkspaceBadgeLabel } from '../RecentSessionCardsSheet'
import { recentCardExecutionHostKey, recentCardRowKey } from '../recent-session-card-snapshot'
import {
  getRecentSessionCardsMaxDisplaySync,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MIN_RECENT_SESSION_CARDS_DISPLAY,
  setRecentSessionCardsMaxDisplay,
  subscribeRecentSessionCards,
  type RecentSessionCardRecord
} from '../recent-session-cards'
import type { MobileSessionController } from '../use-mobile-session-controller'

const TILE_SIZE = 34
const TILE_DOT_RING = 2

function RecentCardIcon({ card }: { card: RecentSessionCardRecord }) {
  if (card.agentId) {
    return <MobileAgentIcon agentId={card.agentId} size={17} />
  }
  if (card.tabType === 'browser') {
    return <Globe size={17} color={colors.textSecondary} />
  }
  if (card.tabType === 'markdown') {
    return <FileText size={17} color={colors.textSecondary} />
  }
  if (card.tabType === 'file') {
    return <File size={17} color={colors.textSecondary} />
  }
  return <SquareTerminal size={17} color={colors.textSecondary} />
}

/** Cross-workspace MRU list shown when the `Recent` segment is active inside MobileSessionTabsSheet. */
export function MobileSessionTabsRecentBody({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const currentExecKey = recentCardExecutionHostKey(executionHost)
  const {
    recentSessionCards,
    jumpingRecentCardKey,
    handleSelectRecentSessionCard,
    worktreeId,
    activeSessionTabId
  } = controller
  const maxDisplay = useSyncExternalStore(
    subscribeRecentSessionCards,
    getRecentSessionCardsMaxDisplaySync,
    getRecentSessionCardsMaxDisplaySync
  )
  const cards = recentSessionCards ?? []
  const visibleCards = useMemo(
    () =>
      cards
        .filter(
          (card) =>
            !(
              Boolean(worktreeId) &&
              Boolean(activeSessionTabId) &&
              card.worktreeId === worktreeId &&
              recentCardExecutionHostKey(card.executionHost) === currentExecKey &&
              card.tabId === activeSessionTabId
            )
        )
        .slice(0, maxDisplay),
    [activeSessionTabId, cards, currentExecKey, maxDisplay, worktreeId]
  )
  const now = useNow(30_000, visibleCards.length > 0)
  const canDecrease = maxDisplay > MIN_RECENT_SESSION_CARDS_DISPLAY
  const canIncrease = maxDisplay < MAX_RECENT_SESSION_CARDS_LIMIT

  return (
    <View style={styles.container}>
      <View style={styles.subHeader}>
        <Text style={styles.caption} numberOfLines={1}>
          {t('session.tabsSheet.recentCaption', 'Recent across workspaces')}
        </Text>
        <View style={styles.limitStepper}>
          <Pressable
            testID="recent-cards-limit-decrease"
            accessibilityRole="button"
            accessibilityLabel={t(
              'session.recentSessionCards.decreaseLimit',
              'Decrease recent cards limit'
            )}
            disabled={!canDecrease}
            hitSlop={6}
            onPress={() => setRecentSessionCardsMaxDisplay(maxDisplay - 1)}
            style={({ pressed }) => [
              styles.limitStepButton,
              !canDecrease && styles.limitStepButtonDisabled,
              pressed && canDecrease && styles.limitStepButtonPressed
            ]}
          >
            <Minus size={12} color={colors.textSecondary} />
          </Pressable>
          <Text testID="recent-cards-limit-value" style={styles.limitValueText}>
            {maxDisplay}
          </Text>
          <Pressable
            testID="recent-cards-limit-increase"
            accessibilityRole="button"
            accessibilityLabel={t(
              'session.recentSessionCards.increaseLimit',
              'Increase recent cards limit'
            )}
            disabled={!canIncrease}
            hitSlop={6}
            onPress={() => setRecentSessionCardsMaxDisplay(maxDisplay + 1)}
            style={({ pressed }) => [
              styles.limitStepButton,
              !canIncrease && styles.limitStepButtonDisabled,
              pressed && canIncrease && styles.limitStepButtonPressed
            ]}
          >
            <Plus size={12} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
      <ListGroup separatorInset={spacing.lg + TILE_SIZE + spacing.md}>
        {visibleCards.length === 0 ? (
          <View key="empty" style={styles.emptyRow}>
            <Text style={styles.emptyText}>
              {t('recentSessionCardsEmpty', 'No other recent cards yet')}
            </Text>
          </View>
        ) : (
          visibleCards.map((card) => {
            const key = recentCardRowKey(card)
            const isJumping = jumpingRecentCardKey === key
            const anyJumping = jumpingRecentCardKey !== null
            const isCurrentWorkspace =
              Boolean(worktreeId) &&
              card.worktreeId === worktreeId &&
              recentCardExecutionHostKey(card.executionHost) === currentExecKey
            const workspaceLabel = getWorktreeLabel(card.worktreeName, card.worktreeId)
            const badgeLabel = formatWorkspaceBadgeLabel(workspaceLabel)
            const timeAgo = formatTimeAgo(card.lastVisitedAt, now)
            const badge =
              card.agentState && card.agentState !== 'idle' ? card.agentState : undefined
            const stateWord = badge ? agentStateLabel(badge) : null
            const unread = card.unread === true
            const showUnreadBell =
              unread &&
              (!badge ||
                (agentStatusGroup(badge) !== 'needs-you' && agentStatusGroup(badge) !== 'working'))
            const accessibilityLabel = [
              card.title,
              unread ? t('agents.list.unread', 'Unread') : null,
              stateWord,
              workspaceLabel,
              timeAgo
            ]
              .filter(Boolean)
              .join(', ')

            return (
              <Pressable
                key={key}
                testID={`recent-session-card-${card.worktreeId}-${card.tabId}`}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                disabled={anyJumping}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => void handleSelectRecentSessionCard(card)}
              >
                <View style={styles.tile}>
                  <RecentCardIcon card={card} />
                  {showUnreadBell || badge ? (
                    <View
                      testID={`recent-session-card-state-dot-${card.worktreeId}-${card.tabId}`}
                      style={styles.tileBadge}
                    >
                      {showUnreadBell ? (
                        <Bell
                          size={10}
                          color={colors.statusAmber}
                          fill={colors.statusAmber}
                          accessibilityLabel={t('agents.list.unread', 'Unread')}
                        />
                      ) : badge ? (
                        <AgentStateDot state={badge} />
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <View style={styles.text}>
                  <Text style={styles.title} numberOfLines={1}>
                    {card.title}
                  </Text>
                  <View style={styles.metaRow}>
                    <View
                      testID={
                        isCurrentWorkspace
                          ? `recent-session-card-current-workspace-${card.worktreeId}-${card.tabId}`
                          : undefined
                      }
                      style={styles.workspaceBadge}
                    >
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={[
                          styles.workspaceBadgeText,
                          isCurrentWorkspace && styles.workspaceBadgeTextCurrent
                        ]}
                      >
                        {badgeLabel}
                      </Text>
                    </View>
                    {stateWord ? (
                      <Text style={styles.stateDetail} numberOfLines={1}>
                        {stateWord}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {isJumping ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Text style={styles.time}>{timeAgo}</Text>
                )}
              </Pressable>
            )
          })
        )}
      </ListGroup>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: { paddingTop: spacing.xs },
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.lg,
    paddingBottom: spacing.xs
  },
  caption: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted
  },
  limitStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.sheetGroup,
    borderRadius: 6,
    paddingHorizontal: 3,
    paddingVertical: 2
  },
  limitStepButton: {
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  limitStepButtonPressed: { backgroundColor: colors.translucentFill },
  limitStepButtonDisabled: { opacity: 0.35 },
  limitValueText: {
    minWidth: 18,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    textAlign: 'center',
    fontVariant: ['tabular-nums']
  },
  emptyRow: { minHeight: 60, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  emptyText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.sheetGroup
  },
  rowPressed: { backgroundColor: colors.translucentFill },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tileBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    padding: TILE_DOT_RING,
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  workspaceBadge: {
    flexShrink: 1,
    maxWidth: 140,
    backgroundColor: colors.translucentFill,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1
  },
  workspaceBadgeText: { fontSize: 12, color: colors.textSecondary },
  workspaceBadgeTextCurrent: { color: colors.accentBlue, fontWeight: '600' },
  stateDetail: { flexShrink: 1, fontSize: 12, color: colors.textMuted },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
