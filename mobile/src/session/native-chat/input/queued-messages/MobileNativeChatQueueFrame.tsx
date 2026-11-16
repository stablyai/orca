import { useContext, type ReactNode } from 'react'
import { View } from 'react-native'
import {
  MobileNativeChatComposerPresenceContext,
  MobileNativeChatQueueAbovePromptContext
} from '../../lower-region/mobile-native-chat-lower-region-context'
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
  // Native keeps the composer mounted (hidden) under a prompt, so presence alone cannot untuck it.
  const abovePrompt = useContext(MobileNativeChatQueueAbovePromptContext)
  const untucked = editing || !composerPresent || abovePrompt
  return (
    <View
      testID={box ? 'queued-box' : undefined}
      style={
        box
          ? [styles.box, untucked && styles.inlineBox, abovePrompt && styles.closedBox]
          : [styles.list, untucked && styles.inlineList, abovePrompt && styles.closedList]
      }
    >
      {children}
    </View>
  )
}
