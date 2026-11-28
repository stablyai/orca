import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  NATIVE_CHAT_USER_MESSAGE_MAX_UNFOLDED_LINES,
  nativeChatUserMessageFolds
} from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-user-message-fold'
import { stylesSheet } from '../../../../components/markdown/mobile-markdown-styles'
import { spacing, typography, pressedStyle } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useNativeChatProseText } from '../../preferences/native-chat-text-settings'
import type { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

export function MobileNativeChatUserMessageFold({
  text,
  fontScale,
  open,
  onToggle,
  recovery,
  status,
  children
}: {
  text: string
  fontScale: number
  // Keep disclosure in the transcript across row recycling.
  open: boolean
  onToggle: () => void
  recovery?: ReturnType<typeof useMobileNativeChatFullMessage>['recovery']
  status?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const markdownStyles = useThemedStyles(stylesSheet)
  const styles = useThemedStyles(stylesThemedSheet)
  const t = useMobileTranslation()
  const longText = useMemo(() => nativeChatUserMessageFolds(text), [text])
  const [height, setHeight] = useState<number | null>(null)
  const { textScale, lineSpacing } = useNativeChatProseText(fontScale, true)
  const clip =
    NATIVE_CHAT_USER_MESSAGE_MAX_UNFOLDED_LINES *
    markdownStyles.paragraph.lineHeight *
    textScale *
    lineSpacing
  // Native clips measure at the folded height; use >= with rounding tolerance or expanding to measure would loop.
  const folds = longText && (height === null || height >= clip - 1)
  return (
    <>
      {longText ? (
        <View style={folds && !open ? { maxHeight: clip, overflow: 'hidden' } : undefined}>
          <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>{children}</View>
        </View>
      ) : (
        children
      )}
      {(!longText || height !== null) && (folds || recovery) ? (
        <Pressable
          style={({ pressed }) => [styles.toggle, pressed && pressedStyle]}
          onPress={() => {
            onToggle()
            if (!open && recovery && recovery.load !== 'loading') {
              recovery.onPress()
            }
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
        >
          <Text style={styles.toggleText}>
            {open
              ? t('chat.nativeChatUserMessageFold.showLess', 'Show less')
              : recovery?.load === 'failed'
                ? t('chat.nativeChatUserMessageFold.loadFailed', 'Retry full message')
                : t('chat.nativeChatUserMessageFold.showFullMessage', 'Show full message')}
          </Text>
        </Pressable>
      ) : null}
      {!recovery || (open && recovery.load === 'failed') ? status : null}
    </>
  )
}

const stylesThemedSheet = themedStyleSheet((colors) => ({
  toggle: {
    alignSelf: 'flex-end',
    paddingTop: spacing.xs
  },
  toggleText: {
    color: colors.chatForegroundStrong,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
