import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, Plus } from 'lucide-react-native'
import { summarizeBotPreview } from '../../../src/shared/bots/bot-collapsed-preview'
import type { BotsListEndLine, Section } from '../worktree/workspace-list/workspace-list-types'
import { colors, pressedStyle, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { DisclosureChevron } from '../components/list/DisclosureChevron'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { WORKTREE_ROW_LAYOUT } from '../worktree/row-presentation/worktree-list-row-layout'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { useSharedNow } from '../hooks/use-now'
import { MobileBotNeedsYouCount } from './MobileBotHomeRow'
import { mobileBotRowNeedsYou } from './mobile-bot-row-line'

export function MobileBotsSectionHeader({
  section,
  collapsed: savedCollapsed,
  pending,
  onToggle,
  onNew
}: {
  section: Section
  collapsed: boolean
  pending: boolean
  onToggle: () => void
  onNew: (() => void) | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useSharedNow(30_000)
  const facts = section.botPreview ?? []
  const count = section.count ?? facts.length
  const canCollapse = count > 0
  const collapsed = canCollapse && savedCollapsed
  const preview = summarizeBotPreview(facts)
  // Folded, the rows' own Needs you counts add up here; else whether any works. Unfolded, the rows say it.
  const needsYou = facts.reduce(
    (sum, bot) => sum + mobileBotRowNeedsYou(bot.needs.line, bot.needs.agents, now),
    0
  )
  const mark = !collapsed ? null : needsYou > 0 ? (
    <MobileBotNeedsYouCount count={needsYou} />
  ) : preview.working > 0 ? (
    <AgentSpinner status="working" />
  ) : null
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onToggle}
        disabled={!canCollapse}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed, disabled: !canCollapse }}
        aria-expanded={!collapsed}
        accessibilityLabel={t(
          'bots.section.summary',
          '{{title}}, {{total}} bots, {{attention}} need you, {{unread}} unread, {{working}} working',
          {
            title: section.title,
            total: preview.total,
            attention: needsYou,
            unread: preview.unread,
            working: preview.working
          }
        )}
        style={({ pressed }) => [
          hostScreenStyles.sectionHeader,
          styles.toggle,
          pressed && styles.togglePressed
        ]}
      >
        <View style={hostScreenStyles.sectionChevron}>
          {canCollapse ? (
            <DisclosureChevron expanded={!collapsed} collapsedDeg={0} expandedDeg={90}>
              <ChevronRight size={12} color={colors.textMuted} />
            </DisclosureChevron>
          ) : null}
        </View>
        <Text style={hostScreenStyles.sectionTitle}>{t('bots.section.title', 'Bots')}</Text>
        <View
          style={styles.countSlot}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {count > 0 ? <Text style={hostScreenStyles.sectionCount}>{count}</Text> : null}
        </View>
        {pending ? (
          <ActivityIndicator
            size="small"
            color={colors.textMuted}
            style={hostScreenStyles.sectionPendingSpinner}
          />
        ) : null}
        {mark ? <View style={styles.mark}>{mark}</View> : null}
      </Pressable>
      {onNew ? (
        <Pressable
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel={t('bots.new.title', 'New bot')}
          hitSlop={spacing.sm}
          style={({ pressed }) => [styles.add, pressed && pressedStyle]}
        >
          <Plus size={16} color={colors.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  )
}

/** Quiet lines after the last bot: no bots yet, or a computer whose bots can't list. */
export function MobileBotsListEnd({
  lines,
  underRows
}: {
  lines: readonly BotsListEndLine[]
  /** Under bot rows, the lines start where their names do; else where the header's title does. */
  underRows: boolean
}) {
  useMobileColorScheme()
  return (
    <View style={[styles.end, underRows && styles.endUnderRows]}>
      {lines.map((line) => (
        <Text key={line.key} style={styles.endLine}>
          {line.text}
        </Text>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  header: { flexDirection: 'row', alignItems: 'center' },
  toggle: { flex: 1, minWidth: 0 },
  togglePressed: { backgroundColor: colors.translucentFill },
  countSlot: { flex: 1 },
  mark: { marginLeft: spacing.sm },
  // The section header's vertical padding puts + on the title's line; 44 pt wide from the edge.
  add: {
    paddingTop: spacing.lg,
    paddingBottom: 6,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg
  },
  end: {
    paddingLeft: WORKTREE_ROW_LAYOUT.textInset,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.md
  },
  // A bot row's picture (32) and its gap.
  endUnderRows: { paddingLeft: spacing.lg + 32 + spacing.md },
  endLine: { fontSize: 13, color: colors.textMuted }
}))
