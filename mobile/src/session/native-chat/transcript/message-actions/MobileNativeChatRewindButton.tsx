import { useContext } from 'react'
import { Pressable, View } from 'react-native'
import { Undo2 } from 'lucide-react-native'
import { MobileNativeChatRewindContext } from './mobile-native-chat-rewind-context'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { radii } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

/** Desktop's "Rewind to here" beside a user row's time; renders nothing where the chat can't rewind to it. */
export function MobileNativeChatRewindButton({ itemId }: { itemId: string }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const rewind = useContext(MobileNativeChatRewindContext)
  const { openRewind } = useContext(MobileNativeChatRowOverlaysContext)
  if (!rewind?.eligibleItemIds.has(itemId)) {
    return null
  }
  // Offered only while the chat can rewind now; its slot stays so the row never jumps at turn start or end.
  if (rewind.disabledReason !== null) {
    return <View style={styles.button} />
  }
  const label = t('chat.messageActionsSheet.rewind', 'Rewind to here')
  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => openRewind(itemId)}
    >
      <Undo2 size={14} color={colors.textMuted} />
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised }
}))
