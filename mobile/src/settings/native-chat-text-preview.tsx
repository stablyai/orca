import { Copy, TextWrap } from 'lucide-react-native'
import { ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { MobileSyntaxSegments } from '../components/code-presentation/MobileSyntaxSegments'
import {
  markdownTonesSheet,
  scaledMarkdownText,
  stylesSheet as markdownStylesSheet
} from '../components/markdown/mobile-markdown-styles'
import type { MobileSyntaxSegment } from '../files/session-documents/mobile-file-syntax'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useNativeChatProseText } from '../session/native-chat/preferences/native-chat-text-settings'
import { stylesSheet as messageStylesSheet } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import {
  toolStylesSheet,
  toolType
} from '../session/native-chat/transcript/tool-results/mobile-native-chat-tool-styles'
import { radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

const PREVIEW_CODE_LANGUAGE = 'ts'

// Pre-tokenized preview snippet matching highlightMobileCode(CODE, 'ts'): avoids bundling markdown-it, entities, lowlight, and highlight.js in the native shell for one static Settings preview.
const PREVIEW_CODE_SEGMENTS: MobileSyntaxSegment[] = [
  { text: 'await', kind: 'keyword' },
  { text: ' vi.', kind: 'plain' },
  { text: 'waitFor', kind: 'function' },
  { text: '(', kind: 'plain' },
  { text: '() =>', kind: 'function' },
  { text: '\n  ', kind: 'plain' },
  { text: 'expect', kind: 'function' },
  { text: '(rows).', kind: 'plain' },
  { text: 'toHaveLength', kind: 'function' },
  { text: '(', kind: 'plain' },
  { text: '3', kind: 'number' },
  { text: '))', kind: 'plain' }
]

type InlineCodePart = { key: string; text: string; code: boolean }

function renderInlineCodeParts(text: string): InlineCodePart[] {
  const parts: InlineCodePart[] = []
  const re = /`([^`]+)`/g
  let lastIndex = 0
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      parts.push({ key: `t:${lastIndex}`, text: text.slice(lastIndex, start), code: false })
    }
    parts.push({ key: `c:${start}`, text: match[1] ?? '', code: true })
    lastIndex = start + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push({ key: `t:${lastIndex}`, text: text.slice(lastIndex), code: false })
  }
  return parts
}

/** The chat's own parts at the chosen text settings: your bubble, a tool line, prose and code. */
export function NativeChatTextPreview({ fontScale: chatScale }: { fontScale: number }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const markdownStyles = useThemedStyles(markdownStylesSheet)
  const tones = useThemedStyles(markdownTonesSheet)
  const toolStyles = useThemedStyles(toolStylesSheet)
  const messageStyles = useThemedStyles(messageStylesSheet)
  const t = useMobileTranslation()
  // Native text grows with the phone's Text Size and the chat page's doesn't; undo it so sizes match the chat.
  const fontScale = chatScale / useWindowDimensions().fontScale
  const prose = useNativeChatProseText(fontScale)
  const mine = useNativeChatProseText(fontScale, true)
  const answer = t(
    'settings.nativeChatText.previewAnswer',
    'The test waits on `setTimeout(0)` while the stream is still flushing, so it passes only when the flush wins.'
  )
  const codeMetrics = [
    markdownStyles.codeText,
    scaledMarkdownText(markdownStyles.codeText, prose.textScale)
  ]
  const inlineCodeScaled =
    prose.textScale !== 1
      ? { fontSize: markdownStyles.inlineCode.fontSize * prose.textScale }
      : null

  return (
    <View
      style={styles.preview}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={messageStyles.rowUser}>
        <View style={messageStyles.userBubble}>
          <Text
            style={[
              markdownStyles.paragraph,
              tones.userMessage.text,
              scaledMarkdownText(markdownStyles.paragraph, mine.textScale, mine.lineSpacing),
              mine.fontFamily ? { fontFamily: mine.fontFamily } : null
            ]}
          >
            {t('settings.nativeChatText.previewQuestion', 'Why is the resume test flaky?')}
          </Text>
        </View>
      </View>
      <Text style={[toolStyles.headerSentence, toolType(fontScale).row]}>
        {t('settings.nativeChatText.previewTools', 'Read 3 files · Ran pnpm test')}
      </Text>
      <View style={markdownStyles.root}>
        <Text
          style={[
            markdownStyles.paragraph,
            tones.reply.text,
            scaledMarkdownText(markdownStyles.paragraph, prose.textScale, prose.lineSpacing),
            prose.fontFamily ? { fontFamily: prose.fontFamily } : null
          ]}
        >
          {renderInlineCodeParts(answer).map((part) =>
            part.code ? (
              <Text
                key={part.key}
                style={[markdownStyles.inlineCode, tones.reply.inlineCode, inlineCodeScaled]}
              >
                {part.text}
              </Text>
            ) : (
              part.text
            )
          )}
        </Text>
        <View style={markdownStyles.codeBlock}>
          <View style={markdownStyles.codeHeader}>
            <Text numberOfLines={1} style={markdownStyles.codeLanguage}>
              {PREVIEW_CODE_LANGUAGE}
            </Text>
            <View style={markdownStyles.codeActions}>
              <View style={markdownStyles.codeWrapButton}>
                <TextWrap size={14} color={colors.textMuted} />
              </View>
              <View style={markdownStyles.codeWrapButton}>
                <Copy size={14} color={colors.textMuted} />
              </View>
            </View>
          </View>
          <View style={markdownStyles.codeBody}>
            <Text
              selectable={false}
              aria-hidden
              style={[codeMetrics, markdownStyles.codeLineNumbers]}
            >
              {'1\n2'}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable style={[codeMetrics, markdownStyles.codeLines]}>
                <MobileSyntaxSegments segments={PREVIEW_CODE_SEGMENTS} />
              </Text>
            </ScrollView>
          </View>
        </View>
      </View>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
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
