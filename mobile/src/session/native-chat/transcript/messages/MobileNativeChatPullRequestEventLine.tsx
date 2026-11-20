import { useContext } from 'react'
import { Text } from 'react-native'
import { GitPullRequest } from 'lucide-react-native'
import type { NativeChatTextBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventCommitUrl,
  pullRequestEventPullRequestUrl,
  pullRequestEventShortSha
} from '../../../../../../src/shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { MarkdownLinkHandlerContext } from '../../../../components/markdown/links/markdown-link-handler'
import { colors } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'

/** "CI failing on orca#3 at 8d5f74b": a status row per finished CI result, without the desktop's Hide
 *  button; the phone follows that setting. */
export function MobileNativeChatPullRequestEventLine({
  block,
  messageId,
  timestamp,
  fontScale,
  onLongPress
}: {
  block: NativeChatTextBlock
  messageId: string
  timestamp: number | null
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openLink = useContext(MarkdownLinkHandlerContext)
  const event = parsePullRequestEventItemId(messageId)
  const failing = block.tone === 'failure'
  const lead = failing
    ? t('chat.ciResultLine.failingLead', 'CI failing on')
    : t('chat.ciResultLine.greenLead', 'CI green on')
  const pullRequestName = event ? `${event.repo}#${event.number}` : ''
  return (
    <MobileNativeChatEventRow
      icon={<GitPullRequest size={14} color={colors.textMuted} strokeWidth={2} />}
      badge={failing ? 'failed' : null}
      label={event ? `${lead} ${pullRequestName}` : block.text}
      timestamp={timestamp}
      fontScale={fontScale}
    >
      {event ? (
        <>
          <Text
            accessibilityRole="link"
            onPress={() => openLink(pullRequestEventPullRequestUrl(event))}
            onLongPress={onLongPress}
          >
            {lead} <MobileNativeChatEventName>{pullRequestName}</MobileNativeChatEventName>
          </Text>{' '}
          {t('chat.ciResultLine.at', 'at')}{' '}
          <Text
            accessibilityRole="link"
            style={styles.link}
            onPress={() => openLink(pullRequestEventCommitUrl(event))}
            onLongPress={onLongPress}
          >
            {pullRequestEventShortSha(event.headSha)}
          </Text>
        </>
      ) : (
        block.text
      )}
    </MobileNativeChatEventRow>
  )
}

const styles = themedStyleSheet(() => ({
  link: { textDecorationLine: 'underline' }
}))
