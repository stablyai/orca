import { useMemo, useState } from 'react'
import { Pressable, SectionList, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { AgentStateDot } from '../components/AgentStateDot'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { colors, pressedStyle, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { agentStateLabel, formatTimeAgo, agentRowTimeAt } from '../worktree/agent-row-display'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import {
  buildHostActivitySections,
  type HostActivityGroup,
  type HostActivityRow
} from './host-activity-sections'
import type { HostScreenController } from './use-host-screen-controller'
import { HostActivityReadBell } from './host-activity-read-bell'
import { agentActivitySubjectKey } from '../../../src/shared/agent-activity-read-state'

export function HostActivityList({
  controller,
  bottomBarHeight
}: {
  controller: HostScreenController
  bottomBarHeight: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { displayWorktrees, state, now, actions, connState } = controller
  const [collapsed, setCollapsed] = useState<Set<HostActivityGroup>>(new Set())
  const sections = useMemo(
    () => buildHostActivitySections(displayWorktrees, state.search, now),
    [displayWorktrees, state.search, now]
  )
  const labels: Record<HostActivityGroup, string> = {
    waiting: t('hostScreen.activity.waiting', 'Waiting'),
    working: t('hostScreen.activity.working', 'Working'),
    monitoring: t('hostScreen.activity.monitoring', 'Monitoring'),
    done: t('hostScreen.activity.done', 'Done'),
    other: t('hostScreen.activity.other', 'Other sessions')
  }
  const count = sections.reduce((sum, section) => sum + section.data.length, 0)
  return (
    <SectionList
      style={styles.list}
      contentContainerStyle={{ paddingBottom: bottomBarHeight + spacing.lg }}
      sections={sections.map((section) => ({
        ...section,
        count: section.data.length,
        data: collapsed.has(section.key) ? [] : section.data
      }))}
      keyExtractor={(item: HostActivityRow) => item.key}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshing={controller.catalog.refreshing}
      onRefresh={() => {
        void controller.catalog.fetchWorktrees({ allowDuringModal: true })
      }}
      ListHeaderComponent={
        <View style={styles.heading}>
          <Text style={styles.title}>{t('hostScreen.activity.title', 'Activity View')}</Text>
          <Text style={styles.meta}>
            {count === 1
              ? t('hostScreen.activity.sessionCount_one', '{{count}} session', { count })
              : t('hostScreen.activity.sessionCount_other', '{{count}} sessions', { count })}
          </Text>
          {connState !== 'connected' ? (
            <Text style={styles.meta}>
              {t('hostScreen.activity.offline', 'Offline · showing last known activity')}
            </Text>
          ) : null}
          {state.catalogError ? <Text style={styles.meta}>{state.catalogError}</Text> : null}
          {controller.activityRead.snapshot.status === 'unsupported' ? (
            <Text style={styles.meta}>
              {t(
                'hostScreen.activity.updateHost',
                'Update Orca on your computer to synchronize notification read status.'
              )}
            </Text>
          ) : controller.activityRead.snapshot.status !== 'ready' ? (
            <Text style={styles.meta}>
              {t('hostScreen.activity.readLoading', 'Notification read status unavailable')}
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Text style={styles.empty}>
          {state.search.trim()
            ? t('hostScreen.activity.noMatches', 'No matching sessions')
            : !state.worktreesLoaded
              ? t('hostScreen.activity.loading', 'Loading sessions…')
              : t('hostScreen.activity.empty', 'No agent sessions on this host')}
        </Text>
      }
      renderSectionHeader={({ section }) => {
        const Icon = collapsed.has(section.key) ? ChevronRight : ChevronDown
        return (
          <Pressable
            style={styles.group}
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed.has(section.key) }}
            accessibilityLabel={`${labels[section.key]}, ${section.count}`}
            onPress={() =>
              setCollapsed((previous) => {
                const next = new Set(previous)
                if (next.has(section.key)) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }
          >
            <Icon size={14} color={colors.textMuted} />
            <Text style={styles.groupTitle}>{labels[section.key]}</Text>
            <Text style={styles.meta}>{section.count}</Text>
          </Pressable>
        )
      }}
      renderItem={({ item }) => (
        <HostActivityCard
          item={item}
          controller={controller}
          onPress={() => {
            if (
              actions.openWorktreeSession(item.worktree, item.agent.paneKey) &&
              controller.activityRead.get(item)?.unread
            ) {
              void controller.activityRead.setRead(item, true)
            }
          }}
        />
      )}
    />
  )
}

function HostActivityCard({
  item,
  controller,
  onPress
}: {
  item: HostActivityRow
  controller: HostScreenController
  onPress: () => void
}) {
  const { agent, worktree, title, dotState } = item
  const message = withoutNativeChatVisualDirectiveLines(agent.lastAssistantMessage ?? '').trim()
  const hostContext = controller.hostContextOf(worktree)
  const readState = controller.activityRead.get(item)
  return (
    <Pressable
      onPress={onPress}
      disabled={controller.isReadOnly}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${agentStateLabel(dotState)}, ${worktree.repo}`}
      style={({ pressed }) => [styles.card, pressed && pressedStyle]}
    >
      <View style={styles.row}>
        <AgentStateDot state={dotState} />
        <Text numberOfLines={1} style={[styles.sessionTitle, readState?.unread && styles.unread]}>
          {title}
        </Text>
        <Text style={styles.meta}>{formatTimeAgo(agentRowTimeAt(agent), controller.now)}</Text>
      </View>
      <Text style={styles.preview} numberOfLines={2}>
        {message || agentStateLabel(dotState)}
      </Text>
      <View style={styles.row}>
        {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null}
        <Text style={styles.meta} numberOfLines={1}>
          {worktree.repo} · {worktree.displayName || worktree.branch}
        </Text>
        <HostActivityReadBell
          unread={readState?.unread}
          pending={
            readState
              ? controller.activityRead.snapshot.pending.has(agentActivitySubjectKey(readState))
              : false
          }
          disabled={
            controller.connState !== 'connected' ||
            controller.activityRead.snapshot.status !== 'ready'
          }
          onChange={(read) => {
            void controller.activityRead.setRead(item, read)
          }}
        />
      </View>
      {hostContext?.hostContextLabel ? (
        <Text style={styles.meta} numberOfLines={1}>
          {hostContext.hostContextLabel}
        </Text>
      ) : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  list: { flex: 1 },
  heading: { padding: spacing.lg, gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, flexShrink: 1 },
  empty: { padding: spacing.lg, color: colors.textMuted, fontSize: typography.bodySize },
  group: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  groupTitle: {
    flex: 1,
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase'
  },
  card: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sessionTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  unread: { fontWeight: '700' },
  preview: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20 }
}))
