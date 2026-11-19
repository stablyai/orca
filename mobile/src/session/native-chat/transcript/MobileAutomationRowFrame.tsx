import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import { colors, typography } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { scaledType } from './messages/mobile-native-chat-message-styles'
import { styles as card } from './agent-messages/mobile-agent-message-card-styles'
import { styles } from './mobile-automation-run-row-styles'
import { MobileAutomationMark } from './MobileAutomationMark'

/** "2:10 PM", as every automation row's time reads on the phone. */
export function mobileAutomationRowTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Every automation row in a phone chat: mark, name, then label · status on a second line (320 pt
 *  can't fit all on one); opens in place. */
export function MobileAutomationRowFrame({
  mark,
  name,
  meta,
  failed = false,
  accessibilityLabel,
  open,
  onToggle,
  action,
  fontScale,
  testID,
  children
}: {
  mark: AutomationRowMark
  name: string
  meta: string
  failed?: boolean
  accessibilityLabel: string
  open: boolean
  onToggle: () => void
  action?: ReactNode
  fontScale: number
  testID?: string
  children?: ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  const Chevron = open ? ChevronUp : ChevronDown
  return (
    <View style={card.compactCard} testID={testID}>
      <View style={card.compactHeader}>
        <Pressable
          style={card.headerToggle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
        />
        <MobileAutomationMark mark={mark} />
        <View pointerEvents="none" style={styles.text}>
          <Text
            numberOfLines={1}
            style={[styles.name, scaledType(typography.bodySize, fontScale, 4)]}
          >
            {name}
          </Text>
          <View style={styles.metaLine}>
            {failed ? <View style={styles.dot} /> : null}
            <Text
              numberOfLines={1}
              style={[styles.meta, scaledType(typography.metaSize, fontScale, 4)]}
            >
              {meta}
            </Text>
          </View>
        </View>
        {action}
        <View pointerEvents="none">
          <Chevron size={14} color={colors.textMuted} />
        </View>
      </View>
      {open && children ? <View style={card.compactBody}>{children}</View> : null}
    </View>
  )
}
