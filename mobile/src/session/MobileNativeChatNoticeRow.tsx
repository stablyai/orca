import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react-native'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeBlock,
  nativeChatNoticeLook,
  type NativeChatNoticeTone
} from '../../../src/shared/native-chat-notice'
import { isTextBlock, type NativeChatBlock } from '../../../src/shared/native-chat-types'
import { usageLimitLineText } from '../../../src/shared/agent-session-usage-limit-words'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { CODE_FONT_FAMILY } from '../components/mobile-markdown-styles'
import { colors, radii, spacing, textStyles } from '../theme/mobile-theme'
import { MONO_SIZE, scaledText, scaledType } from './mobile-native-chat-message-styles'

const TONE_COLOR: Record<NativeChatNoticeTone, string> = {
  warning: colors.statusAmber,
  error: colors.danger,
  notice: colors.textMuted
}

/** A row the agent did not write in its own words, drawn as desktop's `NativeChatNoticeRow` and
 *  its faint system asides are, so it never reads as the agent speaking. */
export function MobileNativeChatNoticeRow({
  blocks,
  fontScale,
  onOpenFile,
  onLongPress
}: {
  blocks: readonly NativeChatBlock[]
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  /** Android only: a long press on a plan's link opens the row's actions sheet. */
  onLongPress?: () => void
}): React.JSX.Element | null {
  const notice = nativeChatNoticeBlock(blocks)
  // A system row with no notice of its own is an aside, a size under the agent's prose.
  const aside = [styles.faint, scaledText(textStyles.callout, fontScale)]
  if (!notice) {
    const text = blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n')
    return text ? (
      <Text selectable={INLINE_TEXT_SELECTION} style={aside}>
        {text}
      </Text>
    ) : null
  }
  const look = nativeChatNoticeLook(notice)
  switch (look.kind) {
    case 'divider': {
      const label = NATIVE_CHAT_NOTICE_COPY[look.label]
      return (
        <View style={styles.divider} accessibilityRole="text" accessibilityLabel={label}>
          <View style={styles.rule} />
          <Text style={[styles.dividerLabel, scaledText(textStyles.footnote, fontScale)]}>
            {label}
          </Text>
          <View style={styles.rule} />
        </View>
      )
    }
    case 'command-output':
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.commandOutput, scaledType(MONO_SIZE, fontScale, 5)]}
        >
          {notice.text}
        </Text>
      )
    case 'host-status':
      return (
        <Text
          selectable={INLINE_TEXT_SELECTION}
          style={[styles.faint, scaledText(textStyles.body, fontScale)]}
        >
          {AGENT_SESSION_HOST_STATUS_COPY[look.presentation]}
        </Text>
      )
    case 'plan':
      return (
        <View style={styles.card}>
          <Text style={[styles.planTitle, scaledText(textStyles.callout, fontScale)]}>
            {NATIVE_CHAT_NOTICE_COPY.plan}
          </Text>
          <MobileMarkdown
            content={notice.text}
            rangeSelectable
            textScale={fontScale}
            onOpenFile={onOpenFile}
            onLongPress={onLongPress}
          />
        </View>
      )
    case 'aside':
      return (
        <Text selectable={INLINE_TEXT_SELECTION} style={aside}>
          {notice.text}
        </Text>
      )
    case 'line': {
      const lineText = usageLimitLineText(notice)
      const textStyle = [
        styles.line,
        scaledText(look.tone ? textStyles.callout : textStyles.body, fontScale),
        look.tone && { color: TONE_COLOR[look.tone] }
      ]
      if (!look.tone) {
        return (
          <Text selectable={INLINE_TEXT_SELECTION} style={textStyle}>
            {lineText}
          </Text>
        )
      }
      const Icon =
        look.tone === 'warning' ? AlertTriangle : look.tone === 'error' ? AlertCircle : Info
      return (
        <View style={[styles.card, styles.toneCard]}>
          <Icon
            size={18 * fontScale}
            color={TONE_COLOR[look.tone]}
            strokeWidth={2}
            style={styles.toneIcon}
          />
          <Text selectable={INLINE_TEXT_SELECTION} style={[...textStyle, styles.toneText]}>
            {lineText}
          </Text>
        </View>
      )
    }
  }
}

const styles = StyleSheet.create({
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator
  },
  dividerLabel: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  faint: {
    ...textStyles.callout,
    color: colors.textMuted
  },
  commandOutput: {
    color: colors.textPrimary,
    fontFamily: CODE_FONT_FAMILY
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm
  },
  planTitle: {
    ...textStyles.callout,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  toneCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md
  },
  toneIcon: {
    marginTop: 1
  },
  line: {
    ...textStyles.body,
    color: colors.textPrimary
  },
  toneText: {
    flex: 1
  }
})
