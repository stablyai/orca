import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, MessageCircleQuestion, Plus } from '../components/icons/app-icons'
import {
  botPreviewCapacity,
  botPreviewSignal,
  collapsedBotPreview,
  type BotPreviewSignal
} from '../../../src/shared/bots/bot-collapsed-preview'
import type { BotsListEndLine, Section } from '../worktree/workspace-list/workspace-list-types'
import { colors, pressedStyle, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { DisclosureChevron } from '../components/list/DisclosureChevron'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { MobileBotAvatar } from './MobileBotAvatar'

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
  const [width, setWidth] = useState(0)
  const facts = section.botPreview ?? []
  const canCollapse = (section.count ?? facts.length) > 0
  const collapsed = canCollapse && savedCollapsed
  const preview = collapsedBotPreview(facts, botPreviewCapacity(width, facts.length))
  const label = t('bots.section.title', 'Bots')
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
        <Text style={hostScreenStyles.sectionTitle}>{label}</Text>
        <View
          style={[styles.preview, collapsed && facts.length > 0 && styles.previewFaces]}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {/* A folded search that matched only groups has no faces to show; its count says it. */}
          {collapsed && facts.length > 0 ? (
            <View style={styles.stack}>
              {preview.shown.map((bot, index) => (
                <View key={bot.id} style={[styles.face, { zIndex: 10 - index }]}>
                  <MobileBotAvatar avatar={bot.avatar} size={20} circular />
                  <Pip signal={botPreviewSignal(bot)} />
                </View>
              ))}
              {preview.hidden.length > 0 ? (
                <View style={[styles.face, styles.more]}>
                  <Text style={styles.moreText}>+{preview.hidden.length}</Text>
                  <Pip signal={preview.hiddenSignal} />
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={styles.count}>{section.count ?? facts.length}</Text>
          )}
        </View>
        {pending ? (
          <ActivityIndicator
            size="small"
            color={colors.textMuted}
            style={hostScreenStyles.sectionPendingSpinner}
          />
        ) : null}
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

// As the desktop's folded preview: the question glyph, the working ring, the blue unread dot.
function Pip({ signal }: { signal: BotPreviewSignal }) {
  if (signal === 'attention') {
    return (
      <View style={[styles.badge, styles.badgeAttention]}>
        <MessageCircleQuestion size={12} color={colors.agentQuestion} />
      </View>
    )
  }
  if (signal === 'working') {
    return (
      <View style={styles.badge}>
        <AgentSpinner status="working" />
      </View>
    )
  }
  return signal === 'unread' ? <View style={styles.unread} /> : null
}

const styles = themedStyleSheet(() => ({
  header: { flexDirection: 'row', alignItems: 'center' },
  toggle: { flex: 1, minWidth: 0 },
  togglePressed: { backgroundColor: colors.translucentFill },
  preview: {
    flex: 1,
    minWidth: 0,
    marginLeft: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  // Faces overhang the title's line by 2 pt each side, so folding never changes the header's height; the
  // 4 pt beyond them holds the pips.
  previewFaces: { height: 28, marginVertical: -6 },
  stack: { flexDirection: 'row', paddingLeft: 5, paddingRight: 2 },
  face: {
    marginLeft: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    outlineWidth: 2,
    outlineColor: colors.bgBase
  },
  more: { backgroundColor: colors.bgRaised, alignItems: 'center', justifyContent: 'center' },
  moreText: { marginLeft: 3, fontSize: 10, fontWeight: '500', color: colors.textSecondary },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  },
  badgeAttention: { width: 14, height: 14, borderRadius: 7 },
  unread: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.bgBase,
    backgroundColor: colors.accentBlue
  },
  count: { alignSelf: 'flex-start', fontSize: 13, color: colors.textMuted },
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
