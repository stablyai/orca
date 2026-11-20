import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight, X } from 'lucide-react-native'
import { AGENT_WORKING_COLOR, WorkingRing } from '../../../../agents/presentation/AgentStateDot'
import {
  colors,
  getMobileColorScheme,
  radii,
  spacing,
  typography
} from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileNativeChatDisclosure } from '../viewport/mobile-native-chat-disclosure-store'
import { useMobileNativeChatMessageTimeLabel } from './MobileNativeChatMessageTime'
import { scaledType } from './mobile-native-chat-message-styles'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

const ROW_SIZE = 13
const ROW_LEADING = 7
const ICON = 14

export type MobileNativeChatEventBadge = 'running' | 'failed'

/** The row's 14pt mark with its state in a badge at the bottom right: a spinner while it runs, a red ✕ when it failed. */
function MobileNativeChatEventIcon({
  children,
  badge
}: {
  children: ReactNode
  badge?: MobileNativeChatEventBadge | null
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View style={styles.mark}>
      {children}
      {badge ? (
        <View style={styles.badge}>
          {badge === 'running' ? (
            <WorkingRing color={AGENT_WORKING_COLOR} style={styles.spinner} />
          ) : (
            <View style={styles.failed}>
              <X size={6} color={colors.bgBase} strokeWidth={4} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

/**
 * One status line in a phone chat: icon · words · action, then chevron and time, all always shown (nothing
 * hovers on a phone). With details the whole row is the button that opens them below, in a quiet fill;
 * the action sits above that button as its own. Its open state lives in the transcript's disclosure store.
 */
export function MobileNativeChatEventRow({
  icon,
  badge,
  children,
  label,
  action,
  timestamp,
  details,
  disclosureKey,
  fontScale,
  onLongPress,
  testID
}: {
  icon: ReactNode
  /** Its state on the mark; VoiceOver hears it with the row's words. */
  badge?: MobileNativeChatEventBadge | null
  /** The row's words: the name in primary text, the rest muted. */
  children: ReactNode
  /** The words as plain text: the row button's name, with the time. */
  label: string
  /** Right after the words, such as an open button. */
  action?: ReactNode
  timestamp?: number | null
  details?: ReactNode
  /** Where the transcript remembers whether this row's details are open. */
  disclosureKey?: string
  fontScale: number
  onLongPress?: () => void
  testID?: string
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const state =
    badge === 'running'
      ? t('chat.eventRow.running', 'Running')
      : badge === 'failed'
        ? t('chat.eventRow.failed', 'Failed')
        : null
  const [open, setOpen] = useMobileNativeChatDisclosure(disclosureKey, false)
  const time = useMobileNativeChatMessageTimeLabel(timestamp)
  const toggles = details !== undefined && details !== null && details !== false
  const type = scaledType(ROW_SIZE, fontScale, ROW_LEADING)
  const line = { height: type.lineHeight }
  return (
    <View testID={testID}>
      <View style={styles.row}>
        {toggles ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[label, state, time?.full].filter(Boolean).join(', ')}
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            onLongPress={onLongPress}
            style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
          />
        ) : null}
        {/* A row with no button says its state on its mark, read just before its words. */}
        <View
          pointerEvents="none"
          accessible={!toggles && state !== null}
          accessibilityLabel={!toggles && state ? state : undefined}
          style={[styles.icon, line]}
        >
          <MobileNativeChatEventIcon badge={badge}>{icon}</MobileNativeChatEventIcon>
        </View>
        <Text
          pointerEvents={toggles ? 'none' : 'auto'}
          numberOfLines={2}
          style={[styles.words, type]}
        >
          {children}
        </Text>
        {action ? <View style={[styles.action, line]}>{action}</View> : null}
        <View pointerEvents="none" style={styles.spacer} />
        {toggles ? (
          <View pointerEvents="none" style={[styles.icon, line, open && styles.chevronOpen]}>
            <ChevronRight size={ICON} color={colors.textMuted} strokeWidth={2} />
          </View>
        ) : null}
        {time ? (
          <Text
            pointerEvents="none"
            style={[styles.time, scaledType(typography.metaSize, fontScale, ROW_LEADING + 1)]}
          >
            {time.short}
          </Text>
        ) : null}
      </View>
      {toggles && open ? <View style={styles.details}>{details}</View> : null}
    </View>
  )
}

/** The name in a row's words. */
export function MobileNativeChatEventName({ children }: { children: ReactNode }) {
  useMobileColorScheme()
  return <Text style={styles.name}>{children}</Text>
}

const styles = themedStyleSheet(() => ({
  row: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6
  },
  toggle: {
    position: 'absolute',
    top: -spacing.xs,
    bottom: -spacing.xs,
    left: -spacing.xs,
    right: -spacing.xs,
    borderRadius: radii.mark
  },
  pressed: { backgroundColor: colors.translucentFill },
  icon: { flexShrink: 0, justifyContent: 'center' },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  words: { flexShrink: 1, minWidth: 0, color: colors.textMuted },
  name: { color: colors.textPrimary },
  action: { flexShrink: 0, justifyContent: 'center' },
  spacer: { flex: 1, minWidth: spacing.sm },
  time: { flexShrink: 0, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  // Indented under the words, past the 14pt mark and its gap.
  details: {
    marginLeft: ICON + 6,
    marginTop: spacing.xxs,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: 6,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
    borderRadius: radii.tile,
    // The quietest fill each scheme has, as the desktop's comment fill.
    backgroundColor: getMobileColorScheme() === 'dark' ? colors.bgPanel : colors.bgRaised
  },
  mark: { width: ICON, height: ICON, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 10,
    height: 10,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  },
  spinner: { width: 7, height: 7, borderRadius: radii.pill, borderWidth: 1.5 },
  failed: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statusRed
  }
}))
