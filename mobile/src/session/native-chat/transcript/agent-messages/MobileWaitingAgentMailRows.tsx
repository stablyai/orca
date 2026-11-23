import { memo, useState } from 'react'
import { Text, View } from 'react-native'
import { Image as ImageIcon } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors } from '../../../../theme/mobile-theme'
import { queuedMessageStyles } from '../../input/queued-messages/mobile-native-chat-queued-message-styles'
import { MobileNativeChatAgentMessageCard } from './MobileNativeChatAgentMessageCard'
import {
  MobileWaitingAgentMailContext,
  type MobileWaitingAgentMail
} from './MobileWaitingAgentMailActions'
import { styles } from '../messages/mobile-native-chat-message-styles'
import { MobileWorkingMotionPausedContext } from '../../../../agents/presentation/AgentStateDot'
import type { MobileNativeChatTailViewport } from '../viewport/mobile-native-chat-tail-viewport'
import {
  createMobileFooterBlock,
  useMobileFooterRowOnScreen,
  type MobileFooterBlock
} from './use-mobile-footer-row-on-screen'

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized, so a streaming update redraws it only when the mail, its actions or the text scale change. */
export const MobileWaitingAgentMailRows = memo(function MobileWaitingAgentMailRows({
  mail,
  fontScale,
  viewport
}: {
  mail: MobileWaitingAgentMail | undefined
  fontScale: number
  /** The list these rows end; without one (over bot setup) they count as on screen. */
  viewport?: MobileNativeChatTailViewport
}): React.JSX.Element | null {
  const [block] = useState(createMobileFooterBlock)
  if (!mail || mail.rows.length === 0) {
    return null
  }
  return (
    <MobileWaitingAgentMailContext.Provider value={mail.actions}>
      <View onLayout={block.onLayout}>
        {mail.rows.map((message) => (
          <MobileWaitingAgentMailRow
            key={message.id}
            message={message}
            fontScale={fontScale}
            viewport={viewport}
            block={block}
          />
        ))}
      </View>
    </MobileWaitingAgentMailContext.Provider>
  )
})

/** The rows for a chat's waiting mail, ending its list (`viewport`) or over bot setup (none). */
export function mobileWaitingAgentMailRows(
  mail: MobileWaitingAgentMail | undefined,
  fontScale: number,
  viewport: MobileNativeChatTailViewport | undefined
): React.JSX.Element {
  return <MobileWaitingAgentMailRows mail={mail} fontScale={fontScale} viewport={viewport} />
}

/** One waiting row, kept as is while its message, the text scale and whether it is on screen are
 *  unchanged. Scrolled away, its sender's working ring stops turning: these rows are never windowed. */
const MobileWaitingAgentMailRow = memo(function MobileWaitingAgentMailRow({
  message,
  fontScale,
  viewport,
  block
}: {
  message: NativeChatMessage
  fontScale: number
  viewport: MobileNativeChatTailViewport | undefined
  block: MobileFooterBlock
}): React.JSX.Element | null {
  const { onScreen, ref, onLayout } = useMobileFooterRowOnScreen(viewport, block)
  if (!message.from) {
    return null
  }
  return (
    <View
      ref={ref}
      onLayout={onLayout}
      style={styles.row}
      testID={`native-chat-waiting-${message.id}`}
    >
      <View style={styles.content}>
        <MobileWorkingMotionPausedContext.Provider value={!onScreen}>
          <MobileNativeChatAgentMessageCard
            message={message}
            from={message.from}
            fontScale={fontScale}
            attachments={<MobileQueuedImageCount message={message} />}
          />
        </MobileWorkingMotionPausedContext.Provider>
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
