import { View } from 'react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatMessageCopyText } from '../../../../../src/shared/native-chat/transcript/native-chat-message-copy-text'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { MobileNativeChatRewindButton } from './MobileNativeChatRewindButton'
import { styles } from './mobile-native-chat-message-styles'

/** A chat turn's time, then its actions together: copy, and rewind on a user row the chat can rewind to. */
export function MobileNativeChatMessageMeta({
  message,
  fontScale,
  rewindable
}: {
  message: NativeChatMessage
  fontScale: number
  rewindable?: true
}): React.JSX.Element {
  const t = useMobileTranslation()
  const copyText = nativeChatMessageCopyText(message)
  return (
    <View style={styles.meta}>
      <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
      {copyText.length > 0 || rewindable ? (
        <View style={styles.metaActions}>
          {copyText.length > 0 ? (
            <MobileSourceCopyButton
              key={message.id}
              text={copyText}
              accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
            />
          ) : null}
          {rewindable ? <MobileNativeChatRewindButton itemId={message.id} /> : null}
        </View>
      ) : null}
    </View>
  )
}
