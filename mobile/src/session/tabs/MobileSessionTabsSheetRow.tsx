import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { TailClippedText } from '../../components/list/TailClippedText'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSessionTabRow, MobileSessionTabSummary } from './mobile-session-tab-rows'
import { isPathTitle } from './MobileSessionTabBarLayer'

export const TABS_SHEET_TILE_SIZE = 34
const TILE_DOT_RING = 2

/** A row of the tabs sheet: tap to open the tab, × (or a swipe) to close it. */
export function TabsSheetRow({
  title,
  accessibilityLabel,
  current,
  pane = false,
  onPress,
  onClose,
  children
}: {
  title: string
  accessibilityLabel: string
  current: boolean
  /** A split's pane, indented under its tab. */
  pane?: boolean
  onPress: () => void
  onClose: () => void
  children: ReactNode
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const closeLabel = t('session.tabsSheet.closeTab', 'Close {{title}}', { title })
  return (
    <SwipeRowActions
      trailing={{
        label: t('common.close', 'Close'),
        accessibilityLabel: closeLabel,
        icon: X,
        background: colors.statusRed,
        foreground: colors.onStatusRed,
        onPress: onClose
      }}
    >
      {(guardPress, guardDragRelease) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ selected: current }}
          style={[tabsSheetRowStyles.row, pane && tabsSheetRowStyles.paneRow]}
          onPress={guardPress(onPress)}
        >
          {({ pressed }) => (
            <>
              {/* The open tab keeps the pressed wash, so it reads as the one you're on. */}
              {pressed || current ? (
                <View pointerEvents="none" style={tabsSheetRowStyles.wash} />
              ) : null}
              {children}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={closeLabel}
                style={({ pressed: closePressed }) => [
                  tabsSheetRowStyles.close,
                  closePressed && tabsSheetRowStyles.closePressed
                ]}
                // × closes even on a row swiped open; only the row's own tap shuts the swipe.
                onPress={(event) => {
                  event.stopPropagation()
                  guardDragRelease(onClose)()
                }}
              >
                <X size={16} color={colors.textMuted} strokeWidth={2.4} />
              </Pressable>
            </>
          )}
        </Pressable>
      )}
    </SwipeRowActions>
  )
}

export function TabsSheetTile({
  mark,
  badge
}: {
  mark: ReactNode
  badge: MobileSessionTabSummary['dotState']
}) {
  const dot = badge && badge !== 'idle' ? badge : undefined
  return (
    <View style={tabsSheetRowStyles.tile}>
      {mark}
      {dot ? (
        <View style={tabsSheetRowStyles.tileBadge}>
          <AgentStateDot state={dot} decorative />
        </View>
      ) : null}
    </View>
  )
}

/** The Agents list's text column: title (bold while unread) with its time, then one detail line. */
export function TabsSheetRowText({
  title,
  unread,
  time,
  children
}: {
  title: ReactNode
  unread: boolean
  time: string
  children: ReactNode
}) {
  const titleStyle = [tabsSheetRowStyles.title, unread && tabsSheetRowStyles.titleUnread]
  return (
    <View style={tabsSheetRowStyles.text}>
      <View style={tabsSheetRowStyles.titleLine}>
        {typeof title === 'string' && isPathTitle(title) ? (
          <View style={tabsSheetRowStyles.pathTitle}>
            <TailClippedText style={titleStyle}>{title}</TailClippedText>
          </View>
        ) : (
          <Text style={[titleStyle, tabsSheetRowStyles.titleFill]} numberOfLines={1}>
            {title}
          </Text>
        )}
        {time ? <Text style={tabsSheetRowStyles.time}>{time}</Text> : null}
      </View>
      {children}
    </View>
  )
}

// The second line only when it adds to the title; paths and URLs keep their end in view.
export function TabsSheetRowDetail({ row }: { row: MobileSessionTabRow }) {
  if (!row.stateWord && !row.content) {
    return null
  }
  if (!row.stateWord && row.tab.type !== 'terminal' && row.tab.type !== 'agent-session') {
    return <TailClippedText style={tabsSheetRowStyles.detail}>{row.content}</TailClippedText>
  }
  const stateStyle = [
    tabsSheetRowStyles.stateWord,
    row.dotState === 'failed'
      ? tabsSheetRowStyles.stateFailed
      : row.group === 'needs-you'
        ? tabsSheetRowStyles.stateNeedsYou
        : null
  ]
  return (
    <Text style={tabsSheetRowStyles.detail} numberOfLines={1}>
      {row.stateWord ? <Text style={stateStyle}>{row.stateWord}</Text> : null}
      {row.stateWord && row.content ? ' · ' : ''}
      {row.content}
    </Text>
  )
}

export const tabsSheetRowStyles = themedStyleSheet(() => ({
  body: { paddingBottom: spacing.lg },
  // Opaque so a swipe's action stays hidden until the row slides off it.
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.sheetGroup
  },
  // Indented under its tab's tile, so the corner arrow points into the split.
  paneRow: { minHeight: 44, paddingLeft: 34, gap: 10, paddingVertical: 6 },
  // A pressed row, washed like a picked segment on a sheet group.
  wash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.translucentFill
  },
  // A 44 pt target whose 16 pt glyph lines up 18 pt from the time and the row's edge.
  close: {
    width: 44,
    height: 44,
    marginLeft: -spacing.sm,
    marginRight: -spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closePressed: { backgroundColor: colors.translucentFill },
  tile: {
    width: TABS_SHEET_TILE_SIZE,
    height: TABS_SHEET_TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The state dot on the tile's corner, ringed in the group's colour.
  tileBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    padding: TILE_DOT_RING,
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup
  },
  paneMark: { width: 24, alignItems: 'center' },
  // The Agents list row's type: 15/20 title, 600 while unread, then a 14/19 line with its state word in 600.
  text: { flex: 1, minWidth: 0, gap: spacing.xxs },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  title: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    color: colors.textPrimary
  },
  titleUnread: { fontWeight: '600' },
  // Gives a path's tail clip the title's room as its edge.
  pathTitle: { flex: 1, minWidth: 0 },
  titleFill: { flex: 1, minWidth: 0 },
  paneTitle: { fontSize: 14, lineHeight: 19, color: colors.textPrimary },
  detail: { fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  stateWord: { fontWeight: '600' },
  stateNeedsYou: { color: colors.agentQuestionText },
  stateFailed: { color: colors.statusRed },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  // Agents list's fold: chevron, then "3 older", lined up with the row text.
  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingLeft: spacing.lg + TABS_SHEET_TILE_SIZE + spacing.md - spacing.xs,
    paddingRight: spacing.lg,
    backgroundColor: colors.sheetGroup
  },
  foldLabel: { fontSize: 14, color: colors.textSecondary },
  hairline: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg + TABS_SHEET_TILE_SIZE + spacing.md,
    backgroundColor: colors.borderSubtle
  },
  groupGap: { marginTop: spacing.lg }
}))
