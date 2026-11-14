import { useId } from 'react'
import { Text, View } from 'react-native'
import { agentSessionFailureDetailText } from '../../../../../src/shared/agent-session/failures/agent-session-failure-quoted-detail'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import type { NativeChatNoticeLook } from '../../../../../src/shared/native-chat/native-chat-notice'
import type { NativeChatTextBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { MONO_SIZE, TEXT_SIZE, scaledType } from './mobile-native-chat-message-styles'
import { toolStyles } from './mobile-native-chat-tool-styles'
import { MobileNativeChatNoticeDisclosure } from './MobileNativeChatNoticeDisclosure'
import { MobileNativeChatOwnedScrollView } from './MobileNativeChatOwnedScrollView'

type CollapsedNoticeLook = Extract<NativeChatNoticeLook, { kind: 'collapsed-notice' }>

function collapsedNoticeSummary(look: CollapsedNoticeLook, t: Translate): string {
  const counts =
    look.attempt && look.maxRetries ? { attempt: look.attempt, max: look.maxRetries } : undefined
  switch (look.label) {
    case 'retrying':
      return counts
        ? t('chat.notice.retryingCount', 'Retrying ({{attempt}} of {{max}}). View details.', counts)
        : t('chat.notice.retrying', 'Retrying. View details.')
    case 'rate-limited':
      return counts
        ? t(
            'chat.notice.rateLimitedRetryingCount',
            'Rate limited, retrying ({{attempt}} of {{max}}). View details.',
            counts
          )
        : t('chat.notice.rateLimitedRetrying', 'Rate limited, retrying. View details.')
    case 'configuration':
      return t(
        'chat.notice.codexConfigurationWarning',
        'Codex configuration warning. View details.'
      )
    case 'deprecation':
      return t('chat.notice.codexDeprecationNotice', 'Codex deprecation notice. View details.')
  }
}

/** A retry or Codex configuration/deprecation notice: one summary line that opens the host's own text. */
export function MobileNativeChatCollapsedNotice({
  notice,
  look,
  fontScale,
  onLongPress,
  disclosureKeys
}: {
  notice: NativeChatTextBlock
  look: CollapsedNoticeLook
  fontScale: number
  onLongPress?: () => void
  /** Where the open choice is kept, newest first. */
  disclosureKeys?: readonly string[]
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useMobileNativeChatDisclosure(disclosureKeys?.[0], false, disclosureKeys)
  const detailId = useId()
  const failureDetail = agentSessionFailureDetailText(
    readWholeAgentSessionFailureFact(notice.failure)
  )
  const detail =
    failureDetail && !notice.text.trim().includes(failureDetail.trim()) ? failureDetail : undefined
  const payload = notice.providerFrame?.payload
  return (
    <View>
      <MobileNativeChatNoticeDisclosure
        summary={collapsedNoticeSummary(look, t)}
        expanded={open}
        fontScale={fontScale}
        onPress={() => setOpen(!open)}
        onLongPress={onLongPress}
        style={[styles.summary, look.label === 'configuration' && styles.configuration]}
      />
      {open ? (
        <MobileNativeChatOwnedScrollView
          positionKey={detailId}
          style={[toolStyles.codeBox, toolStyles.codeScroll]}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <Text
            selectable={INLINE_TEXT_SELECTION}
            style={[styles.prose, scaledType(TEXT_SIZE, fontScale)]}
          >
            {notice.text}
            {detail ? `\n\n${detail}` : ''}
          </Text>
          {payload ? (
            <>
              <Text style={[styles.caption, scaledType(typography.metaSize, fontScale)]}>
                {t('chat.notice.providerResponse', 'Provider response')}
              </Text>
              <Text
                selectable={INLINE_TEXT_SELECTION}
                style={[toolStyles.codeText, scaledType(MONO_SIZE, fontScale)]}
              >
                {payload.truncated
                  ? `${t(
                      'chat.notice.truncatedResponse',
                      'Provider response truncated (original size: {{bytes}} bytes).',
                      { bytes: payload.byteLength }
                    )}\n`
                  : ''}
                {payload.head}
              </Text>
            </>
          ) : null}
        </MobileNativeChatOwnedScrollView>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  summary: {
    minHeight: 44,
    paddingVertical: 0
  },
  // The rule sits in the gutter so the summary stays aligned with its neighbours.
  configuration: {
    marginLeft: -(spacing.sm + 2),
    borderLeftWidth: 2,
    borderLeftColor: colors.statusAmber,
    paddingLeft: spacing.sm
  },
  prose: {
    color: colors.textPrimary
  },
  caption: {
    marginTop: spacing.sm,
    color: colors.textMuted
  }
}))
