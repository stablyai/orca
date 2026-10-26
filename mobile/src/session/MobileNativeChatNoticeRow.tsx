import { useContext } from 'react'
import { MobileHeldTerminalContext } from './mobile-held-terminal-context'
export { MobileHeldTerminalContext } from './mobile-held-terminal-context'
import { HELD_TERMINAL_CONTINUE_SENTENCE } from '../../../src/shared/agent-session-failure-copy'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
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
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { MONO_SIZE, TEXT_SIZE, scaledType } from './mobile-native-chat-message-styles'

const TONE_COLOR: Record<NativeChatNoticeTone, string> = {
  warning: colors.statusAmber,
  error: colors.statusRed,
  notice: colors.textMuted
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
  const holder = useContext(MobileHeldTerminalContext)
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
      const pane = notice.heldByTerminal && parsePaneKey(notice.heldByTerminal.paneKey)
      const tab =
        holder &&
        notice.failure?.kind === 'conversationOpenInTerminal' &&
        notice.heldByTerminal?.worktreeId === holder.worktreeId &&
        pane
          ? holder.tabs.find(
              (tab) =>
                tab.type === 'terminal' &&
                !!notice.heldByTerminal?.incarnationId &&
                tab.incarnationId === notice.heldByTerminal.incarnationId &&
                (tab.parentTabId ?? tab.id) === pane.tabId &&
                tab.leafId === pane.leafId
            )
          : undefined
      const lineText =
        tab && holder
          ? HELD_TERMINAL_CONTINUE_SENTENCE.replace(/<\/?terminal>/g, '')
              .replace('{{agent}}', tuiAgentDisplayName(holder.agent))
              .replace('{{terminal}}', getMobileSessionTabTitle(tab))
          : usageLimitLineText(notice)
      const textStyle = [
        styles.line,
        scaledType(TEXT_SIZE, fontScale),
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
            size={16 * fontScale}
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
})
