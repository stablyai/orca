import { useContext } from 'react'
import { Pressable } from 'react-native'
import { Undo2 } from 'lucide-react-native'
import { MobileNativeChatRewindContext } from './mobile-native-chat-rewind-context'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, radii } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

/** Desktop's "Rewind to here" beside a user row's time; renders nothing where the chat can't rewind to it. */
export function MobileNativeChatRewindButton({ itemId }: { itemId: string }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const rewind = useContext(MobileNativeChatRewindContext)
  const { openRewind } = useContext(MobileNativeChatRowOverlaysContext)
  if (!rewind?.eligibleItemIds.has(itemId)) {
    return null
  }
  const label = t('chat.messageActionsSheet.rewind', 'Rewind to here')
  const { disabledReason } = rewind
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        disabledReason !== null && styles.disabled,
        pressed && styles.pressed
      ]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabledReason ?? undefined}
      accessibilityState={{ disabled: disabledReason !== null }}
      onPress={() => openRewind(itemId)}
    >
      <Undo2 size={14} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  disabled: { opacity: 0.5 },
  pressed: { backgroundColor: colors.bgRaised }
}))
