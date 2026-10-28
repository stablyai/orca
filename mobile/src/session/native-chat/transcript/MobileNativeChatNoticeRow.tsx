import { useContext } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react-native'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../../../src/shared/agent-session-host-status-rows'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeBlock,
  nativeChatNoticeLook,
  type NativeChatNoticeTone
} from '../../../../../src/shared/native-chat/native-chat-notice'
import {
  isTextBlock,
  type NativeChatBlock,
  type NativeChatTextBlock
} from '../../../../../src/shared/native-chat-types'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../src/shared/agent-session-failure-words'
import { formatUsageLimitResetClock } from '../../../../../src/shared/agent-session-usage-limit'
import {
  nativeChatOrcaStopRowText,
  sayNativeChatOrcaStopEnglish
} from '../../../../../src/shared/native-chat/native-chat-orca-stop-words'
import {
  MobileNativeChatNoticeContext,
  type MobileNativeChatNoticeNames
} from '../../mobile-native-chat-notice-context'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MONO_SIZE, TEXT_SIZE, scaledType } from './mobile-native-chat-message-styles'

function toneColor(tone: NativeChatNoticeTone): string {
  return { warning: colors.statusAmber, error: colors.statusRed, notice: colors.textMuted }[tone]
}

// Desktop's no-Continue wording; the phone always reads its Orca host as remote.
function noticeLineText(notice: NativeChatTextBlock, names: MobileNativeChatNoticeNames): string {
  if (notice.orcaStop) {
    return nativeChatOrcaStopRowText(
      notice.orcaStop.cause,
      names.hostName ?? sayNativeChatOrcaStopEnglish('unnamedServer'),
      { continueAvailable: false, remoteHost: true }
    )
  }
  const failure = readWholeAgentSessionFailureFact(notice.failure)
  return failure?.kind === 'usageLimitReached'
    ? agentSessionFailureSentence(failure, 'row', {
        ...(names.agentName ? { agentName: names.agentName } : {}),
        usageLimitReset: formatUsageLimitResetClock
      })
    : notice.text
}

// Render system notices separately so they cannot read as the agent’s own prose.
export function MobileNativeChatNoticeRow({
  blocks,
  fontScale,
  onOpenFile,
  onLongPress
}: {
  blocks: readonly NativeChatBlock[]
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  onLongPress?: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const names = useContext(MobileNativeChatNoticeContext)
  const notice = nativeChatNoticeBlock(blocks)
  const aside = [styles.faint, scaledType(typography.bodySize, fontScale)]
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
          <Text style={styles.dividerLabel}>{label}</Text>
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
          style={[styles.faint, scaledType(TEXT_SIZE, fontScale)]}
        >
          {AGENT_SESSION_HOST_STATUS_COPY[look.presentation]}
        </Text>
      )
    case 'plan':
      return (
        <View style={styles.card}>
          <Text style={styles.planTitle}>{NATIVE_CHAT_NOTICE_COPY.plan}</Text>
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
      const lineText = noticeLineText(notice, names)
      const textStyle = [
        styles.line,
        scaledType(TEXT_SIZE, fontScale),
        look.tone && { color: toneColor(look.tone) }
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
            size={16 * fontScale}
            color={toneColor(look.tone)}
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

const styles = themedStyleSheet(() => ({
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  dividerLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  faint: {
    color: colors.textMuted
  },
  commandOutput: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel,
    padding: spacing.md,
    gap: spacing.sm
  },
  planTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  toneCard: {
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  toneIcon: {
    marginTop: 2
  },
  line: {
    color: colors.textPrimary
  },
  toneText: {
    flex: 1
  }
}))
