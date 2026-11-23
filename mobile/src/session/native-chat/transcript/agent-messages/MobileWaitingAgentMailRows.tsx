import { memo } from 'react'
import { Text, View } from 'react-native'
import { Image as ImageIcon } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors } from '../../../../theme/mobile-theme'
import { queuedMessageStyles } from '../../input/queued-messages/mobile-native-chat-queued-message-styles'
import { MobileNativeChatAgentMessageCard } from './MobileNativeChatAgentMessageCard'
import {
  MobileWaitingAgentMailContext,
  type MobileWaitingAgentMailActionsValue
} from './MobileWaitingAgentMailActions'
import { styles } from '../messages/mobile-native-chat-message-styles'

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized, so a streaming update redraws it only when the mail, its actions or the text scale change. */
export const MobileWaitingAgentMailRows = memo(function MobileWaitingAgentMailRows({
  mail,
  fontScale
}: {
  mail: MobileWaitingAgentMailActionsValue | undefined
  fontScale: number
}): React.JSX.Element | null {
  if (!mail || mail.rows.length === 0) {
    return null
  }
  return (
    <MobileWaitingAgentMailContext.Provider value={mail}>
      {mail.rows.map((message) => (
        <MobileWaitingAgentMailRow key={message.id} message={message} fontScale={fontScale} />
      ))}
    </MobileWaitingAgentMailContext.Provider>
  )
})

/** One waiting row, kept as is while its message and the text scale are unchanged. */
const MobileWaitingAgentMailRow = memo(function MobileWaitingAgentMailRow({
  message,
  fontScale
}: {
  message: NativeChatMessage
  fontScale: number
}): React.JSX.Element | null {
  if (!message.from) {
    return null
  }
  return (
    <View style={styles.row} testID={`native-chat-waiting-${message.id}`}>
      <View style={styles.content}>
        <MobileNativeChatAgentMessageCard
          message={message}
          from={message.from}
          fontScale={fontScale}
          attachments={<MobileQueuedImageCount message={message} />}
        />
      </View>
    </View>
  )
})

/** The waiting message's images as its queued card counted them; they show in full once delivered. */
function MobileQueuedImageCount({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const count = message.blocks.filter((block) => block.type === 'image-ref').length
  if (count === 0) {
    return null
  }
  return (
    <View
      style={queuedMessageStyles.metaLine}
      accessible
      accessibilityLabel={
        count === 1
          ? t('session.queuedMessageCardRow.images_one', '{{count}} image', { count })
          : t('session.queuedMessageCardRow.images_other', '{{count}} images', { count })
      }
    >
      <ImageIcon size={12} color={colors.textSecondary} strokeWidth={2} />
      <Text style={queuedMessageStyles.metaText}>{count}</Text>
    </View>
  )
}
