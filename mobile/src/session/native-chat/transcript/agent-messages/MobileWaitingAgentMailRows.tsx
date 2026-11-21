import { useContext } from 'react'
import { View } from 'react-native'
import { MobileNativeChatAgentMessageCard } from './MobileNativeChatAgentMessageCard'
import { MobileWaitingAgentMailContext } from './MobileWaitingAgentMailActions'
import { styles } from '../messages/mobile-native-chat-message-styles'

/** Other agents' waiting mail, after the conversation's live activity: it is not part of the turn. */
export function MobileWaitingAgentMailRows({
  fontScale
}: {
  fontScale: number
}): React.JSX.Element | null {
  const mail = useContext(MobileWaitingAgentMailContext)
  if (!mail || mail.rows.length === 0) {
    return null
  }
  return (
    <>
      {mail.rows.map((message) =>
        message.from ? (
          <View key={message.id} style={styles.row} testID={`native-chat-waiting-${message.id}`}>
            <View style={styles.content}>
              <MobileNativeChatAgentMessageCard
                message={message}
                from={message.from}
                fontScale={fontScale}
                attachments={null}
              />
            </View>
          </View>
        ) : null
      )}
    </>
  )
}
