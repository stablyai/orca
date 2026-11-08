import { useContext, type ReactNode } from 'react'
import { View } from 'react-native'
import { MobileNativeChatComposerPresenceContext } from '../mobile-native-chat-lower-region-context'
import { queuedMessageStyles as styles } from './mobile-native-chat-queued-message-styles'

export function MobileNativeChatQueueFrame({
  box = false,
  editing,
  children
}: {
  box?: boolean
  editing: boolean
  children: ReactNode
}) {
  const composerPresent = useContext(MobileNativeChatComposerPresenceContext)
  const untucked = editing || !composerPresent
  return (
    <View
      testID={box ? 'queued-box' : undefined}
      style={
        box
          ? [styles.box, untucked && styles.inlineBox]
          : [styles.list, untucked && styles.inlineList]
      }
    >
      {children}
    </View>
  )
}
