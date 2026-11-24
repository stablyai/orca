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
import { MobileCollapsedBotPreview } from './MobileCollapsedBotPreview'

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
  const facts = section.botPreview ?? []
  const canCollapse = (section.count ?? facts.length) > 0
  const collapsed = canCollapse && savedCollapsed
  const showAvatars = collapsed && facts.length > 0
  const preview = summarizeBotPreview(facts)
  const label = t('bots.section.title', 'Bots')
  const pendingSpinner = pending ? (
    <ActivityIndicator
      size="small"
      color={colors.textMuted}
      style={hostScreenStyles.sectionPendingSpinner}
    />
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
            attention: preview.attention,
            unread: preview.unread,
            working: preview.working
          }
        )}
        style={({ pressed }) => [
          hostScreenStyles.sectionHeader,
          showAvatars ? styles.previewToggle : styles.toggle,
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
        <Text style={hostScreenStyles.sectionTitle}>{label}</Text>
        {showAvatars ? null : (
          <>
            <View
              style={styles.countSlot}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.count}>{section.count ?? facts.length}</Text>
            </View>
            {pendingSpinner}
          </>
        )}
      </Pressable>
      {showAvatars ? (
        <View style={[hostScreenStyles.sectionHeader, styles.previewLane]}>
          <MobileCollapsedBotPreview bots={facts} />
          {pendingSpinner}
        </View>
      ) : null}
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
  /** Under bot rows, the lines start where their names do. */
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
  previewToggle: { maxWidth: '60%', paddingRight: 0 },
  togglePressed: { backgroundColor: colors.translucentFill },
  previewLane: { flex: 1, minWidth: 0, paddingLeft: 6 },
  countSlot: { flex: 1, marginLeft: 6 },
  count: { fontSize: 13, color: colors.textMuted },
  // The section header's vertical padding puts + on the title's line; 44 pt wide from the edge.
  add: {
    paddingTop: spacing.lg,
    paddingBottom: 6,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg
  },
  end: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.md },
  // A bot row's picture (32) and its gap.
  endUnderRows: { paddingLeft: spacing.lg + 32 + spacing.md },
  endLine: { fontSize: 13, color: colors.textMuted }
}))
