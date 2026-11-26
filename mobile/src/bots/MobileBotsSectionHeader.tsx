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
  onNew,
  first
}: {
  section: Section
  collapsed: boolean
  pending: boolean
  /** No header sits above it, so it sits closer to the page title. */
  first: boolean
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
    <View style={[hostScreenStyles.sectionHeader, first && hostScreenStyles.sectionHeaderFirst]}>
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
        hitSlop={HEADER_HIT_SLOP}
        style={({ pressed }) => [
          hostScreenStyles.sectionToggle,
          pressed && hostScreenStyles.sectionTogglePressed
        ]}
      >
        <Text style={hostScreenStyles.sectionTitle} numberOfLines={1}>
          {t('bots.section.title', 'Bots')}
        </Text>
        {count > 0 ? (
          <Text
            style={hostScreenStyles.sectionCount}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {count}
          </Text>
        ) : null}
        {pending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        {mark}
        <View style={hostScreenStyles.sectionSpacer} />
      </Pressable>
      {onNew ? (
        <Pressable
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel={t('bots.new.title', 'New bot')}
          hitSlop={ADD_HIT_SLOP}
          style={({ pressed }) => [hostScreenStyles.sectionAdd, pressed && pressedStyle]}
        >
          <Plus size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
      {canCollapse ? (
        <Pressable
          onPress={onToggle}
          hitSlop={ADD_HIT_SLOP}
          importantForAccessibility="no"
          accessibilityElementsHidden
          style={hostScreenStyles.sectionChevron}
        >
          <DisclosureChevron expanded={!collapsed} collapsedDeg={0} expandedDeg={90}>
            <ChevronRight size={16} color={colors.textMuted} />
          </DisclosureChevron>
        </Pressable>
      ) : null}
    </View>
  )
}

// The header is 34 pt tall; these grow its targets to 44 without moving the text.
const HEADER_HIT_SLOP = { top: 5, bottom: 5 } as const
const ADD_HIT_SLOP = { top: 5, bottom: 5, left: 4, right: 4 } as const

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
