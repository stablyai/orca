import { nativeChatAskRequiresTerminal } from '../../../src/shared/native-chat-agent-support'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { askOwnsComposer } from './mobile-native-chat-answer-layout'
import { View } from 'react-native'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  const {
    setMobileSessionRootRef,
    nativeChatController: chat,
    dictation,
    keyboardLift,
    insets
  } = controller
  const answeringAboveLandscapeKeyboard =
    useResponsiveLayout().isLandscapePhone &&
    keyboardLift > 0 &&
    chat.showNativeChat &&
    askOwnsComposer(
      chat.nativeChatAsk,
      !chat.nativeChatStructured && nativeChatAskRequiresTerminal(chat.nativeChatAgent ?? ''),
      chat.nativeChatCollapsedPrompt != null,
      dictation.isRecording
    )
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View
        style={[
          styles.kavInner,
          answeringAboveLandscapeKeyboard && {
            paddingTop: insets.top,
            paddingLeft: insets.left,
            paddingRight: insets.right
          }
        ]}
      >
        <View style={answeringAboveLandscapeKeyboard && styles.answeringHeaderHidden}>
          <MobileSessionHeader controller={controller} />
        </View>
        {/* Content-row host (KTD2): on wide, content shares this row with the docked panel as the flex-1 left child. */}
        <MobileSessionContentRow controller={controller} />
      </View>
      <MobileSessionSheets controller={controller} />
    </View>
  )
}
