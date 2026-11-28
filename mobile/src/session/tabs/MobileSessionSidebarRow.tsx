import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { TailClippedText } from '../../components/list/TailClippedText'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { isPathTitle, type MobileSessionTabRow } from './mobile-session-tab-rows'

/** A sidebar row: tap to go there; × (when given) closes it. The open tab keeps the pressed fill. */
export function SidebarRow({
  accessibilityLabel,
  current = false,
  pane = false,
  closeLabel,
  onPress,
  onClose,
  children
}: {
  accessibilityLabel: string
  current?: boolean
  /** A split's pane, indented under its tab. */
  pane?: boolean
  closeLabel?: string
  onPress: () => void
  onClose?: () => void
  children: ReactNode
}) {
  const colors = useMobileColors()
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: current }}
      style={({ pressed }) => [
        sidebarRowStyles.row,
        pane && sidebarRowStyles.paneRow,
        (pressed || current) && sidebarRowStyles.filled
      ]}
      onPress={onPress}
    >
      {children}
      {onClose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          style={({ pressed }) => [
            sidebarRowStyles.close,
            pressed && sidebarRowStyles.closePressed
          ]}
          onPress={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <X size={13} color={colors.textMuted} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </Pressable>
  )
}

/** The tab's mark with its agent's state on the corner, ringed in the sidebar's ground. */
export function SidebarRowMark({
  mark,
  state
}: {
  mark: ReactNode
  state: MobileSessionTabRow['dotState']
}) {
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  const dot = state && state !== 'idle' ? state : undefined
  return (
    <View style={sidebarRowStyles.mark}>
      {mark}
      {dot ? (
        <View style={sidebarRowStyles.markBadge}>
          <AgentStateDot state={dot} decorative />
        </View>
      ) : null}
    </View>
  )
}

/** The title, bold while unread, and an optional second line (what a waiting agent asks). */
export function SidebarRowText({
  title,
  unread,
  children
}: {
  title: ReactNode
  unread: boolean
  children?: ReactNode
}) {
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  const titleStyle = [sidebarRowStyles.title, unread && sidebarRowStyles.titleUnread]
  return (
    <View style={sidebarRowStyles.text}>
      {typeof title === 'string' && isPathTitle(title) ? (
        <TailClippedText style={titleStyle}>{title}</TailClippedText>
      ) : (
        <Text style={titleStyle} numberOfLines={1}>
          {title}
        </Text>
      )}
      {children}
    </View>
  )
}

/** A waiting agent's ask: the state word in the needs-you colour, then what it wants. */
export function SidebarRowAsk({
  row
}: {
  row: Pick<MobileSessionTabRow, 'stateWord' | 'content' | 'dotState'>
}) {
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  const t = useMobileTranslation()
  if (!row.stateWord && !row.content) {
    return null
  }
  return (
    <Text style={sidebarRowStyles.detail} numberOfLines={1}>
      <Text style={row.dotState === 'failed' ? sidebarRowStyles.failed : sidebarRowStyles.ask}>
        {row.stateWord || t('session.sidebar.needsYou', 'Needs you')}
      </Text>
      {row.content ? ` ${row.content}` : ''}
    </Text>
  )
}

/** A section's label, the list's 13 pt label lined up with the rows' marks, with its count. */
export function SidebarLabel({ title, count }: { title: string; count?: number }) {
  const sidebarRowStyles = useThemedStyles(sidebarRowStylesSheet)
  return (
    <View style={sidebarRowStyles.label}>
      <Text style={sidebarRowStyles.labelText} numberOfLines={1}>
        {title}
      </Text>
      {count ? <Text style={sidebarRowStyles.labelText}>{count}</Text> : null}
    </View>
  )
}

const ROW_RADIUS = radii.control
export const SIDEBAR_MARK_SIZE = 20

export const sidebarRowStylesSheet = themedStyleSheet((colors, scheme) => {
  const ground = scheme === 'dark' ? colors.bgPanel : colors.bgRaised
  return {
    row: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingLeft: spacing.md,
      // 44 pt for one line, 58 with an ask under it, as the mock's rows.
      paddingVertical: 10,
      borderRadius: ROW_RADIUS
    },
    // Indented under its tab's mark, so the corner arrow points into the split.
    paneRow: {
      minHeight: 40,
      paddingVertical: spacing.xs,
      paddingLeft: spacing.md + SIDEBAR_MARK_SIZE + spacing.md
    },
    filled: { backgroundColor: colors.translucentFill },
    // 44 tall; its glyph sits 22 pt from the panel's edge, as the mock's does.
    close: {
      width: 44,
      height: 44,
      marginVertical: -10,
      marginRight: -spacing.xs,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center'
    },
    closePressed: { backgroundColor: colors.translucentFill },
    mark: {
      width: SIDEBAR_MARK_SIZE,
      height: SIDEBAR_MARK_SIZE,
      alignItems: 'center',
      justifyContent: 'center'
    },
    markBadge: {
      position: 'absolute',
      right: -5,
      bottom: -4,
      padding: 2,
      borderRadius: radii.pill,
      backgroundColor: ground
    },
    // ListGroup's SectionHeader type and spacing.
    label: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      paddingLeft: spacing.md,
      paddingTop: spacing.lg,
      paddingBottom: 6
    },
    labelText: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.textSecondary },
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: colors.textPrimary },
    titleUnread: { fontWeight: '600' },
    detail: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    ask: { fontWeight: '600', color: colors.agentQuestionText },
    failed: { fontWeight: '600', color: colors.statusRed }
  }
})
