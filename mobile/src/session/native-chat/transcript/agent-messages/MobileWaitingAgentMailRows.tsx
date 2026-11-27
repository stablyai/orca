import { memo, useState } from 'react'
import { Text, View, type LayoutChangeEvent } from 'react-native'
import { useMobileScreenReaderOn } from '../../../../platform/accessibility/use-mobile-screen-reader-on'
import { Image as ImageIcon } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { queuedMessageStylesSheet } from '../../input/queued-messages/mobile-native-chat-queued-message-styles'
import { MobileNativeChatAgentMessageCard } from './MobileNativeChatAgentMessageCard'
import {
  MobileWaitingAgentMailContext,
  type MobileWaitingAgentMail
} from './MobileWaitingAgentMailActions'
import { stylesSheet } from '../messages/mobile-native-chat-message-styles'
import type { MobileNativeChatTailViewport } from '../viewport/mobile-native-chat-tail-viewport'
import {
  useMobileFooterBlock,
  useMobileFooterRowOnScreen,
  type MobileFooterBlock
} from './use-mobile-footer-row-on-screen'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../../theme/themed-styles'

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn.
 *  Memoized, so a streaming update redraws it only when the mail, its actions or the text scale change. */
export const MobileWaitingAgentMailRows = memo(function MobileWaitingAgentMailRows({
  mail,
  fontScale,
  viewport
}: {
  mail: MobileWaitingAgentMail | undefined
  fontScale: number
  /** The chat's list these rows end; under bot setup its own scroller stands in for it. */
  viewport?: MobileNativeChatTailViewport
}): React.JSX.Element | null {
  const block = useMobileFooterBlock(viewport)
  const screenReader = useMobileScreenReaderOn()
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
            block={block}
            windowed={!screenReader}
          />
        ))}
      </View>
    </MobileWaitingAgentMailContext.Provider>
  )
})

/** The rows for a chat's waiting mail, ending its list (`viewport`) or under bot setup; none when no mail waits. */
export function mobileWaitingAgentMailRows(
  mail: MobileWaitingAgentMail | undefined,
  fontScale: number,
  viewport: MobileNativeChatTailViewport | undefined
): React.JSX.Element | null {
  return mail && mail.rows.length > 0 ? (
    <MobileWaitingAgentMailRows mail={mail} fontScale={fontScale} viewport={viewport} />
  ) : null
}

/** One waiting row. Off screen it keeps only its measured height and none of its card: the list
 *  does not window these rows, so the block does, and a far row holds no sender status or motion. */
const MobileWaitingAgentMailRow = memo(function MobileWaitingAgentMailRow({
  message,
  fontScale,
  block,
  windowed
}: {
  message: NativeChatMessage
  fontScale: number
  block: MobileFooterBlock
  /** Off while a screen reader runs, so swiping reaches every waiting row. */
  windowed: boolean
}): React.JSX.Element | null {
  const styles = useThemedStyles(stylesSheet)
  const { onScreen, ref, onLayout } = useMobileFooterRowOnScreen(block, message.id)
  const [height, setHeight] = useState<number | null>(null)
  const held = windowed && !onScreen && height !== null
  const laidOut = (event: LayoutChangeEvent): void => {
    onLayout(event)
    // Every drawn layout, so a row that arrived off screen is windowed too.
    if (!held) {
      setHeight(event.nativeEvent.layout.height)
    }
  }
  if (!message.from) {
    return null
  }
  return (
    <View
      ref={ref}
      onLayout={laidOut}
      style={held ? [styles.row, { height }] : styles.row}
      testID={`native-chat-waiting-${message.id}`}
    >
      {held ? null : (
        <View style={styles.content}>
          <MobileNativeChatAgentMessageCard
            message={message}
            from={message.from}
            fontScale={fontScale}
            attachments={<MobileQueuedImageCount message={message} />}
          />
        </View>
      )}
    </View>
  )
})

/** The waiting message's images as its queued card counted them; they show in full once delivered. */
function MobileQueuedImageCount({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const queuedMessageStyles = useThemedStyles(queuedMessageStylesSheet)
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
