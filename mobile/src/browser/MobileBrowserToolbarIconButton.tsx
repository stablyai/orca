import { Pressable, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native'
import type { ReactNode } from 'react'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useSessionListLongPressProps } from '../navigation/session-list-long-press-props'

function readKey(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'key' in value ? value.key : undefined
}

function keyboardKey(event: GestureResponderEvent): string | undefined {
  const key = readKey(event.nativeEvent) ?? readKey(event)
  return typeof key === 'string' ? key : undefined
}

type Props = {
  children: ReactNode
  disabled?: boolean
  label: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
  toSessionList?: boolean
}

export function MobileBrowserToolbarIconButton({
  children,
  disabled,
  label,
  onPress,
  style,
  toSessionList = false
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const sessionListLongPress = useSessionListLongPressProps()
  // A disabled Pressable drops onLongPress, so empty history still accepts the session-list hold.
  const keepLongPress =
    disabled === true && toSessionList && sessionListLongPress.onLongPress != null
  // Web never fires onLongPress from the keyboard. A pointer click has no key, so the tap stays a no-op.
  const onPressHoldOnly = (event: GestureResponderEvent) => {
    const key = keyboardKey(event)
    if (key != null) {
      sessionListLongPress.onLongPress?.()
    }
  }
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        style,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled === true && !keepLongPress}
      onPress={keepLongPress ? onPressHoldOnly : disabled ? undefined : onPress}
      accessibilityRole={keepLongPress ? 'button' : undefined}
      accessibilityLabel={label}
      {...(toSessionList ? sessionListLongPress : {})}
    >
      {children}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 26,
    height: 26,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonPressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.35
  }
}))
