import { useContext } from 'react'
import { Text, View } from 'react-native'
import { CircleCheck, CircleX } from 'lucide-react-native'
import type { NativeChatTextBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventCommitUrl,
  pullRequestEventPullRequestUrl,
  pullRequestEventShortSha
} from '../../../../../src/shared/native-chat/native-chat-pull-request-event'
import { MarkdownLinkHandlerContext } from '../../../components/markdown-link-handler'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { scaledType } from './mobile-native-chat-message-styles'

/** "CI failing on orca#3 at 8d5f74b": the desktop's line, without its Hide button; the phone follows that setting. */
export function MobileNativeChatPullRequestEventLine({
  block,
  messageId,
  fontScale
}: {
  block: NativeChatTextBlock
  messageId: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openLink = useContext(MarkdownLinkHandlerContext)
  const event = parsePullRequestEventItemId(messageId)
  const failing = block.tone === 'failure'
  const Icon = failing ? CircleX : CircleCheck
  return (
    <View style={styles.row}>
      <Icon
        size={14 * fontScale}
        color={failing ? colors.statusRed : colors.statusGreen}
        strokeWidth={2}
      />
      <Text style={[styles.text, scaledType(typography.metaSize, fontScale)]} numberOfLines={1}>
        {event ? (
          <>
            {failing
              ? t('chat.ciResultLine.failingLead', 'CI failing on')
              : t('chat.ciResultLine.greenLead', 'CI green on')}{' '}
            <Text
              accessibilityRole="link"
              style={styles.link}
              onPress={() => openLink(pullRequestEventPullRequestUrl(event))}
            >
              {`${event.repo}#${event.number}`}
            </Text>{' '}
            {t('chat.ciResultLine.at', 'at')}{' '}
            <Text
              accessibilityRole="link"
              style={styles.link}
              onPress={() => openLink(pullRequestEventCommitUrl(event))}
            >
              {pullRequestEventShortSha(event.headSha)}
            </Text>
          </>
        ) : (
          block.text
        )}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs
  },
  text: {
    flexShrink: 1,
    color: colors.textMuted
  },
  link: {
    textDecorationLine: 'underline'
  }
}))
