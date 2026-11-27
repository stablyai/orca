import { View } from 'react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatMessageCopyText } from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-message-copy-text'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import { MobileNativeChatRewindButton } from '../message-actions/MobileNativeChatRewindButton'
import { MobileNativeChatResponseActions } from '../message-actions/MobileNativeChatResponseActions'
import { styles } from './mobile-native-chat-message-styles'

/** A reply's copy and ⋯ (its time, fork and the rest); your own message shows only Rewind, while the chat can. */
export function MobileNativeChatMessageMeta({
  message,
  rewindable
}: {
  message: NativeChatMessage
  rewindable?: true
}): React.JSX.Element | null {
  if (message.role === 'user') {
    return rewindable ? (
      <View style={styles.meta}>
        <View style={styles.metaActions}>
          <MobileNativeChatRewindButton itemId={message.id} />
        </View>
      </View>
    ) : null
  }
  // A row of tool work alone says nothing to act on; an image or visual reply still has ⋯.
  const content = deriveNativeChatRowContent(message.blocks)
  if (!content.hasText && !content.hasImages) {
    return null
  }
  return (
    <View style={[styles.meta, styles.metaReply]}>
      <View style={styles.metaActions}>
        <MobileNativeChatResponseActions
          message={message}
          copyText={nativeChatMessageCopyText(message)}
        />
      </View>
    </View>
  )
}
