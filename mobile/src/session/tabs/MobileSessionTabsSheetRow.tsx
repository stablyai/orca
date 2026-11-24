import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Bell, X } from 'lucide-react-native'
import { TailClippedText } from '../../components/list/TailClippedText'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileSessionTabRow, MobileSessionTabSummary } from './mobile-session-tab-rows'

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
  badge,
  unreadBell
}: {
  mark: ReactNode
  badge: MobileSessionTabSummary['dotState']
  unreadBell: boolean
}) {
  const dot = badge && badge !== 'idle' ? badge : undefined
  return (
    <View style={tabsSheetRowStyles.tile}>
      {mark}
      {unreadBell || dot ? (
        <View style={tabsSheetRowStyles.tileBadge}>
          {unreadBell ? (
            <Bell size={10} color={colors.statusAmber} fill={colors.statusAmber} />
          ) : dot ? (
            <AgentStateDot state={dot} decorative />
          ) : null}
        </View>
      ) : null}
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
  const stateStyle =
    row.dotState === 'failed'
      ? tabsSheetRowStyles.stateFailed
      : row.group === 'needs-you'
        ? tabsSheetRowStyles.stateNeedsYou
        : undefined
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
    minHeight: 52,
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
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  paneTitle: { fontSize: 14, color: colors.textPrimary },
  detail: { fontSize: 13, color: colors.textSecondary },
  stateNeedsYou: { color: colors.agentQuestionText },
  stateFailed: { color: colors.statusRed },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
