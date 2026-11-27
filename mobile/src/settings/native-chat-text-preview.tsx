import { Text, View, useWindowDimensions } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useNativeChatProseText } from '../session/native-chat/preferences/native-chat-text-settings'
import { MobileNativeChatMarkdown } from '../session/native-chat/transcript/message-content/MobileNativeChatMarkdown'
import { styles as messageStyles } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import {
  toolStyles,
  toolType
} from '../session/native-chat/transcript/tool-results/mobile-native-chat-tool-styles'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const CODE = '```ts\nawait vi.waitFor(() =>\n  expect(rows).toHaveLength(3))\n```'

/** The chat's own parts at the chosen text settings: your bubble, a tool line, prose and code. */
export function NativeChatTextPreview({ fontScale: chatScale }: { fontScale: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Native text grows with the phone's Text Size and the chat page's doesn't; undo it so sizes match the chat.
  const fontScale = chatScale / useWindowDimensions().fontScale
  const prose = useNativeChatProseText(fontScale)
  const mine = useNativeChatProseText(fontScale, true)
  return (
    <View
      style={styles.preview}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={messageStyles.rowUser}>
        <View style={messageStyles.userBubble}>
          <MobileNativeChatMarkdown
            content={t('settings.nativeChatText.previewQuestion', 'Why is the resume test flaky?')}
            tone="userMessage"
            {...mine}
          />
        </View>
      </View>
      <Text style={[toolStyles.headerSentence, toolType(fontScale).row]}>
        {t('settings.nativeChatText.previewTools', 'Read 3 files · Ran pnpm test')}
      </Text>
      <MobileNativeChatMarkdown
        content={`${t(
          'settings.nativeChatText.previewAnswer',
          'The test waits on `setTimeout(0)` while the stream is still flushing, so it passes only when the flush wins.'
        )}\n\n${CODE}`}
        tone="reply"
        {...prose}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  preview: {
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderRadius: radii.surface,
    backgroundColor: colors.chatCanvas,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  }
}))
