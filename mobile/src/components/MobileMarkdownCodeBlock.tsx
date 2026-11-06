import { TextWrap } from 'lucide-react-native'
import { memo, useContext, useMemo } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { highlightMobileCode } from '../session/mobile-file-syntax'
import {
  MobileNativeChatDisclosureContext,
  MobileNativeChatMarkdownRowKeyContext,
  useMobileNativeChatDisclosure
} from '../session/native-chat/transcript/mobile-native-chat-disclosure-store'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'
import { MobileSourceCopyButton } from './MobileSourceCopyButton'
import { scaledMarkdownText, styles } from './mobile-markdown-styles'
import { MarkdownText } from './mobile-markdown-text'

export const MobileMarkdownCodeBlock = memo(function MobileMarkdownCodeBlock({
  code,
  language,
  textScale,
  sourceLine
}: {
  code: string
  language: string | undefined
  textScale: number
  /** The fence's line in the message; with the chat row it names this block's wrap choice. */
  sourceLine?: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Only chat code offers wrap, as on desktop; the transcript keeps the choice, never persisted.
  const chat = useContext(MobileNativeChatDisclosureContext) !== null
  const rowKey = useContext(MobileNativeChatMarkdownRowKeyContext)
  const [wrapped, setWrapped] = useMobileNativeChatDisclosure(
    rowKey && sourceLine !== undefined ? `code-wrap:${rowKey}:${sourceLine}` : undefined,
    false
  )
  const segments = useMemo(
    () => (language ? highlightMobileCode(code, language.toLowerCase()).segments : null),
    [code, language]
  )
  const lineNumbers = useMemo(
    () => Array.from({ length: code.split('\n').length }, (_, index) => index + 1).join('\n'),
    [code]
  )
  const metrics = [styles.codeText, scaledMarkdownText(styles.codeText, textScale)]
  const lines = (
    <MarkdownText
      selectable
      style={[metrics, styles.codeLines, wrapped && styles.codeLinesWrapped]}
    >
      {segments ? <MobileSyntaxSegments segments={segments} /> : code}
    </MarkdownText>
  )
  const wrapLabel = wrapped
    ? t('components.markdownBlocks.disableLineWrap', 'Disable line wrap')
    : t('components.markdownBlocks.wrapLines', 'Wrap lines')
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text numberOfLines={1} style={styles.codeLanguage}>
          {language}
        </Text>
        <View style={styles.codeActions}>
          {chat && code ? (
            <Pressable
              style={({ pressed }) => [
                styles.codeWrapButton,
                wrapped && styles.codeWrapButtonOn,
                pressed && pressedStyle
              ]}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={wrapLabel}
              accessibilityState={{ selected: wrapped }}
              aria-pressed={wrapped}
              onPress={() => setWrapped(!wrapped)}
            >
              <TextWrap size={14} color={wrapped ? colors.textPrimary : colors.textMuted} />
            </Pressable>
          ) : null}
          {code ? (
            <MobileSourceCopyButton
              text={code}
              accessibilityLabel={t('components.markdownBlocks.copyCode', 'Copy code')}
            />
          ) : null}
        </View>
      </View>
      <View style={styles.codeBody}>
        {/* A separate column, so selecting or copying the code never picks up line numbers.
            Wrapped lines would drift from it, so wrapping drops it. */}
        {code && !wrapped ? (
          <Text selectable={false} aria-hidden style={[metrics, styles.codeLineNumbers]}>
            {lineNumbers}
          </Text>
        ) : null}
        {wrapped ? (
          lines
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {lines}
          </ScrollView>
        )}
      </View>
    </View>
  )
})
