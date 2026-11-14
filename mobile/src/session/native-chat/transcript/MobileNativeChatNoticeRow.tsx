import {
  CLAUDE_MODEL_FALLBACK_COPY,
  claudeModelFallbackLabels
} from '../../../../../src/shared/native-chat/claude-model-fallback'
import { useContext, useId, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react-native'
import { MobileNativeChatInterruptedContinueButton } from './MobileNativeChatInterruptedContinueButton'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeLook,
  type NativeChatNoticeTone
} from '../../../../../src/shared/native-chat/native-chat-notice'
import {
  isTextBlock,
  type NativeChatBlock,
  type NativeChatTextBlock
} from '../../../../../src/shared/native-chat/native-chat-types'
import {
  agentSessionFailureDetailText,
  readWholeAgentSessionFailureFact
} from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { agentSessionSignInCommand } from '../../../../../src/shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { nativeChatOrcaStopRowText } from '../../../../../src/shared/native-chat/native-chat-orca-stop-words'
import {
  MobileNativeChatForkedFromContext,
  MobileNativeChatNoticeContext,
  type MobileNativeChatNoticeView
} from './mobile-native-chat-notice-context'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { nativeChatHostStatusCopy, nativeChatNoticeCopy } from './native-chat-notice-copy'
import { nativeChatOrcaStopSay } from './native-chat-orca-stop-copy'
import { nativeChatUsageLimitText } from './native-chat-usage-limit-copy'
import { sayMobileAgentSessionFailure } from '../agent-session/agent-session-failure-copy'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION } from '../../../../../src/shared/native-chat/native-chat-stopped-before-start'
import { MONO_SIZE, TEXT_SIZE, scaledType } from './mobile-native-chat-message-styles'
import { MobileNativeChatOwnedScrollView } from './MobileNativeChatOwnedScrollView'
import { toolStyles } from './mobile-native-chat-tool-styles'
import { MobileNativeChatUsageLimitStatus } from './MobileNativeChatUsageLimitStatus'
import { MobileNativeChatNoticeDisclosure } from './MobileNativeChatNoticeDisclosure'
import { sheetPrimaryButtonStyles } from '../../../components/SheetPrimaryButton'

function toneColor(tone: NativeChatNoticeTone): string {
  return { warning: colors.statusAmber, error: colors.statusRed, notice: colors.textMuted }[tone]
}

// The phone always reads its Orca host as remote.
function noticeLineText(
  notice: NativeChatTextBlock,
  names: MobileNativeChatNoticeView,
  t: Translate
): string {
  if (notice.orcaStop) {
    const say = nativeChatOrcaStopSay(t)
    return nativeChatOrcaStopRowText(
      notice.orcaStop.cause,
      names.hostName ?? say('unnamedServer'),
      { continueAvailable: names.continuation?.continueAvailable === true, remoteHost: true },
      say
    )
  }
  const failure = readWholeAgentSessionFailureFact(notice.failure)
  if (failure?.kind === 'usageLimitReached') {
    return nativeChatUsageLimitText(failure.usageLimit, names.agentName, t)
  }
  // Only reword text fully described by its fact; other host text stays as written.
  const context = { agentName: names.agentName }
  const surface =
    failure &&
    [
      'savedConversationMissing',
      'pluginInputRequired',
      'modelUnavailable',
      'providerUnavailable',
      'providerSafetyStopped',
      'providerResponseFailed'
    ].includes(failure.kind)
      ? (['row', 'rejection'] as const).find(
          (candidate) => notice.text === agentSessionFailureSentence(failure, candidate, context)
        )
      : undefined
  return failure && surface
    ? agentSessionFailureSentence(failure, surface, context, sayMobileAgentSessionFailure)
    : notice.text
}

// Render system notices separately so they cannot read as the agent’s own prose.
export function MobileNativeChatNoticeRow({
  blocks,
  fontScale,
  onLongPress
}: {
  blocks: readonly NativeChatBlock[]
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const copy = nativeChatNoticeCopy(t)
  const names = useContext(MobileNativeChatNoticeContext)
  const openForkSource = useContext(MobileNativeChatForkedFromContext)
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
  const lineText = noticeLineText(notice, names, t)
  const failure = readWholeAgentSessionFailureFact(notice.failure)
  const failureDetail = agentSessionFailureDetailText(failure)
  const signInCommand =
    failure?.kind === 'notSignedIn'
      ? agentSessionSignInCommand(names.agentName, { account: failure.account, remote: true })
      : null
  const runInTerminal = names.onRunInTerminal
  const detail = failureDetail?.trim() !== lineText.trim() ? failureDetail : undefined
  const diagnosticText = look.kind === 'settled-permission' ? notice.text : detail
  const payload = notice.providerFrame?.payload
  const diagnosticBody = (
    <MobileNativeChatOwnedScrollView
      positionKey={detailId}
      style={[toolStyles.codeBox, toolStyles.codeScroll]}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
    >
      <Text
        selectable={INLINE_TEXT_SELECTION}
        style={[
          toolStyles.codeText,
          scaledType(MONO_SIZE, fontScale),
          look.kind === 'settled-permission' && { color: toneColor(look.tone) }
        ]}
      >
        {diagnosticText}
        {diagnosticText && payload ? '\n\n' : ''}
        {payload?.truncated
          ? `${t(
              'chat.notice.truncatedResponse',
              'Provider response truncated (original size: {{bytes}} bytes).',
              { bytes: payload.byteLength }
            )}\n`
          : ''}
        {payload?.head}
      </Text>
    </MobileNativeChatOwnedScrollView>
  )
  switch (look.kind) {
    case 'settled-permission': {
      const agent = names.agentName ?? look.agent
      const summary =
        look.decision === 'approved'
          ? t('chat.notice.safetyReviewApproved', '{{agent}} approved this action. View details.', {
              agent
            })
          : look.decision === 'denied'
            ? t('chat.notice.permissionDenied', '{{agent}} denied permission. View details.', {
                agent
              })
            : t(
                'chat.notice.safetyReview',
                '{{agent}} reported a safety review warning. View details.',
                {
                  agent
                }
              )
      return (
        <View>
          <MobileNativeChatNoticeDisclosure
            summary={summary}
            expanded={expanded}
            fontScale={fontScale}
            onPress={() => setExpanded((open) => !open)}
            onLongPress={onLongPress}
          />
          {expanded ? diagnosticBody : null}
        </View>
      )
    }
    case 'divider': {
      const label = copy[look.label]
      return (
        <View style={styles.divider} accessibilityRole="text" accessibilityLabel={label}>
          <View style={styles.rule} />
          <Text style={styles.dividerLabel}>{label}</Text>
          <View style={styles.rule} />
        </View>
      )
    }
    case 'forked-from': {
      const { sourceName, sourceSessionId } = look
      return (
        // No label on the row: it would replace the text and hide the source link from screen readers.
        <View style={styles.divider}>
          <View style={styles.rule} />
          <Text style={styles.dividerLabel}>
            {copy.forkedFrom}{' '}
            {openForkSource ? (
              <Text
                accessibilityRole="link"
                style={styles.dividerLink}
                onPress={() => openForkSource(sourceSessionId)}
              >
                {sourceName}
              </Text>
            ) : (
              sourceName
            )}
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
          style={[styles.faint, scaledType(TEXT_SIZE, fontScale)]}
        >
          {nativeChatHostStatusCopy(t)[look.presentation]}
        </Text>
      )
    case 'model-fallback':
      return (
        <Text selectable={INLINE_TEXT_SELECTION} style={aside}>
          {t(
            'chat.notice.modelFallback',
            CLAUDE_MODEL_FALLBACK_COPY,
            claudeModelFallbackLabels(look)
          )}
        </Text>
      )
    case 'plan':
      return (
        <View style={styles.card}>
          <Text style={styles.planTitle}>{copy.plan}</Text>
          <MobileNativeChatMarkdown
            content={notice.text}
            rangeSelectable
            textScale={fontScale}
            onLongPress={onLongPress}
          />
        </View>
      )
    case 'aside':
      return (
        <Text selectable={INLINE_TEXT_SELECTION} style={aside}>
          {notice.presentation === NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
            ? t('chat.notice.stoppedManually', 'Stopped manually')
            : notice.text}
        </Text>
      )
    case 'line': {
      const textStyle = [
        styles.line,
        scaledType(TEXT_SIZE, fontScale),
        look.tone && { color: toneColor(look.tone) }
      ]
      const continuation = names.continuation
      const continueOffered =
        continuation !== undefined &&
        notice.orcaStop?.turnItemId !== undefined &&
        notice.orcaStop.turnItemId === continuation.offeredTurnItemId
      const content = (
        <View style={look.tone ? styles.toneText : undefined}>
          <Text selectable={INLINE_TEXT_SELECTION} style={textStyle}>
            {lineText}
          </Text>
          {continueOffered ? (
            <MobileNativeChatInterruptedContinueButton onPress={continuation.continueNow} />
          ) : signInCommand && runInTerminal ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint={t(
                'chat.notice.signInHint',
                'Opens a terminal on the computer running this chat'
              )}
              onPress={() => runInTerminal(signInCommand)}
              style={({ pressed }) => [
                sheetPrimaryButtonStyles.button,
                styles.action,
                pressed && sheetPrimaryButtonStyles.pressed
              ]}
            >
              <Text style={sheetPrimaryButtonStyles.label}>
                {t('chat.notice.signIn', 'Sign in')}
              </Text>
            </Pressable>
          ) : null}
          <MobileNativeChatUsageLimitStatus notice={notice} fontScale={fontScale} />
          {detail || payload ? (
            <View>
              <MobileNativeChatNoticeDisclosure
                summary={t('pullRequest.markdownBlocks.details', 'Details')}
                expanded={expanded}
                fontScale={fontScale}
                onPress={() => setExpanded((open) => !open)}
                onLongPress={onLongPress}
              />
              {expanded ? diagnosticBody : null}
            </View>
          ) : null}
        </View>
      )
      if (!look.tone) {
        return content
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
          {content}
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
  dividerLink: {
    textDecorationLine: 'underline'
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
    borderRadius: radii.surface,
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
  },
  action: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm
  }
}))
