import { useContext } from 'react'
import { Text, View } from 'react-native'
import { CircleCheck, CircleX } from 'lucide-react-native'
import type { NativeChatTextBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventCommitUrl,
  pullRequestEventPullRequestUrl,
  pullRequestEventShortSha
} from '../../../../../../src/shared/native-chat/native-chat-pull-request-event'
import { MarkdownLinkHandlerContext } from '../../../../components/markdown-link-handler'
import { INLINE_TEXT_SELECTION } from '../../../../components/inline-text-selection'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { scaledType } from './mobile-native-chat-message-styles'

/** "CI failing on orca#3 at 8d5f74b": the desktop's one-line card, without its Hide button; the phone follows that setting. */
export function MobileNativeChatPullRequestEventLine({
  block,
  messageId,
  fontScale,
  onLongPress
}: {
  block: NativeChatTextBlock
  messageId: string
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openLink = useContext(MarkdownLinkHandlerContext)
  const event = parsePullRequestEventItemId(messageId)
  const failing = block.tone === 'failure'
  const Icon = failing ? CircleX : CircleCheck
  const text = {
    selectable: INLINE_TEXT_SELECTION,
    onLongPress,
    numberOfLines: 1
  }
  const type = scaledType(typography.metaSize, fontScale)
  const lead = failing
    ? t('chat.ciResultLine.failingLead', 'CI failing on')
    : t('chat.ciResultLine.greenLead', 'CI green on')
  const pullRequestName = event ? `${event.repo}#${event.number}` : ''
  return (
    <View style={styles.card}>
      <Icon
        size={14 * fontScale}
        color={failing ? colors.statusRed : colors.statusGreen}
        strokeWidth={2}
      />
      {event ? (
        <>
          {/* Only the lead and PR name truncate, and all of it opens the PR, so both links stay reachable. */}
          <Text
            {...text}
            accessibilityRole="link"
            accessibilityLabel={`${lead} ${pullRequestName}`}
            onPress={() => openLink(pullRequestEventPullRequestUrl(event))}
            style={[styles.lead, type]}
          >
            {lead} <Text style={styles.link}>{pullRequestName}</Text>
          </Text>
          <Text {...text} style={[styles.commit, type]}>
            {t('chat.ciResultLine.at', 'at')}{' '}
            <Text
              accessibilityRole="link"
              style={styles.link}
              onPress={() => openLink(pullRequestEventCommitUrl(event))}
            >
              {pullRequestEventShortSha(event.headSha)}
            </Text>
          </Text>
        </>
      ) : (
        <Text {...text} style={[styles.lead, type]}>
          {block.text}
        </Text>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // The phone's chat card frame, as the turn diff card uses.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    padding: spacing.sm
  },
  lead: {
    flexShrink: 1,
    color: colors.textMuted
  },
  commit: {
    flexShrink: 0,
    color: colors.textMuted
  },
  link: {
    textDecorationLine: 'underline'
  }
}))
