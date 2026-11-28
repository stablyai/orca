import { useContext } from 'react'
import { Pressable, View } from 'react-native'
import { Ellipsis } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { MobileSourceCopyButton } from '../../../../components/code-presentation/MobileSourceCopyButton'
import { pressedStyle, spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'

/** Copy, then ⋯ for the rest (time, select, fork), under an agent's reply. */
export function MobileNativeChatResponseActions({
  message,
  copyText
}: {
  message: NativeChatMessage
  copyText: string
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { openActions } = useContext(MobileNativeChatRowOverlaysContext)
  return (
    <View style={styles.actions}>
      {copyText.length > 0 ? (
        <MobileSourceCopyButton
          key={message.id}
          text={copyText}
          accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
        />
      ) : null}
      <Pressable
        style={({ pressed }) => [styles.button, pressed && pressedStyle]}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('chat.message.moreActions', 'More actions')}
        onPress={() => openActions(message)}
      >
        <Ellipsis size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  // Two 44 pt targets side by side: 24 pt boxes, 10 pt slop each, so they never overlap.
  actions: {
    flexDirection: 'row',
    gap: spacing.xl
  },
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center'
  }
}))
