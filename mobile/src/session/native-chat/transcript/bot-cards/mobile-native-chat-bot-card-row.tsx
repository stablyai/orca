import { View } from 'react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatBotMessageCardOf } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { styles } from '../messages/mobile-native-chat-message-styles'
import { mobileNativeChatRowId } from '../viewport/mobile-native-chat-reading-place'
import { mobileNativeChatOtherBotCard } from './mobile-native-chat-bot-cards'
import { MobileNativeChatBotCreatedRow } from '../MobileNativeChatBotRowNotes'

/** A bot's own row: an answered setup card's receipt (its card shows it), a bot created, a message
 *  drawn as a bot card (a tool the bot added), or mail a request card already shows, which folds into
 *  that card; null for any other message. */
export function mobileNativeChatBotCardRow(
  message: NativeChatMessage,
  rowId: string,
  fontScale: number,
  foldedIntoRequest: boolean
): React.JSX.Element | null {
  if (message.orcaNotice === 'card-answer') {
    return <View testID={mobileNativeChatRowId(rowId)} />
  }
  if (message.orcaNotice === 'bot-created') {
    return <MobileNativeChatBotCreatedRow rowId={rowId} />
  }
  const card = nativeChatBotMessageCardOf(message)
  if (card) {
    return (
      <View style={styles.row} testID={mobileNativeChatRowId(rowId)}>
        {mobileNativeChatOtherBotCard(card, {
          cardId: message.id,
          timestamp: message.timestamp,
          fallback: '',
          fontScale
        })}
      </View>
    )
  }
  return foldedIntoRequest ? <View testID={mobileNativeChatRowId(rowId)} /> : null
}
