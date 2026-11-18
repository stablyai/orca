import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, Plus } from 'lucide-react-native'
import {
  botPreviewCapacity,
  botPreviewSignal,
  collapsedBotPreview,
  type BotPreviewSignal
} from '../../../src/shared/bots/bot-collapsed-preview'
import type { BotsListEndLine, Section } from '../worktree/workspace-list/workspace-list-types'
import { colors, feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { DisclosureChevron } from '../components/list/DisclosureChevron'
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
    <View>
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
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <Text style={styles.label}>{label}</Text>
          <View
            style={styles.preview}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {collapsed ? (
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
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : canCollapse ? (
            <DisclosureChevron expanded={!collapsed} collapsedDeg={0} expandedDeg={90}>
              <ChevronRight size={14} color={colors.textMuted} />
            </DisclosureChevron>
          ) : null}
        </Pressable>
        {onNew ? (
          <Pressable
            onPress={onNew}
            accessibilityRole="button"
            accessibilityLabel={t('bots.new.title', 'New bot')}
            style={({ pressed }) => [styles.add, pressed && styles.pressed]}
          >
            <Plus size={16} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>
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

function Pip({ signal }: { signal: BotPreviewSignal }) {
  return signal ? (
    <View
      style={[
        styles.pip,
        {
          backgroundColor:
            signal === 'attention'
              ? colors.statusAmber
              : signal === 'working'
                ? colors.statusAmber
                : colors.textPrimary
        }
      ]}
    />
  ) : null
}

const styles = themedStyleSheet(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    minHeight: 44
  },
  toggle: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  preview: { flex: 1, minWidth: 0, alignItems: 'center', overflow: 'hidden', paddingVertical: 4 },
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
  pip: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.bgBase
  },
  count: { alignSelf: 'flex-start', fontSize: 13, color: colors.textMuted },
  add: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: feedback.pressedOpacity },
  end: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.md },
  // A bot row's picture (32) and its gap.
  endUnderRows: { paddingLeft: spacing.lg + 32 + spacing.md },
  endLine: { fontSize: 13, color: colors.textMuted }
}))
