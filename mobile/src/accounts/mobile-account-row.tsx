import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { pressTransition } from '../components/ui/transition-styles'
import { styles } from './mobile-accounts-screen-styles'

export function readableAccountsError(message: string): string {
  return message === 'Invalid accounts snapshot from host'
    ? 'Your desktop sent account details this version can’t read. Update Orca on both devices.'
    : message
}

/** One pickable account: a trailing check when it's in use, a spinner while switching to it. */
export function AccountRow({
  title,
  subtitle,
  active,
  busy,
  disabled,
  onPress,
  children
}: {
  title: string
  subtitle?: string
  active: boolean
  busy: boolean
  disabled: boolean
  onPress: () => void
  children?: ReactNode
}) {
  const blocked = disabled || active
  return (
    <Pressable
      onPress={() => {
        triggerSelection()
        onPress()
      }}
      disabled={blocked}
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityState={{ checked: active, selected: active, disabled: blocked, busy }}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            pressed && styles.rowPressed,
            disabled && !active && !busy && styles.rowDisabled,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            {subtitle !== undefined ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
            {children}
          </View>
          <View style={styles.rowTrailing}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : active ? (
              <Check size={18} color={colors.textPrimary} strokeWidth={2.4} />
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  )
}
