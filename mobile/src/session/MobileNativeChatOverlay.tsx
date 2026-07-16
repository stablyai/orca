import { StyleSheet, View } from 'react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'

type Props = {
  controller: MobileNativeChatController
  onAttachImage: () => void
  isAttaching: boolean
  onMicPress: () => void
  micActive: boolean
  dictationMode: 'toggle' | 'hold'
  onMicPressIn: () => void
  onMicPressOut: () => void
  inputLockReason: MobileNativeChatInputLockReason | null
  keyboardInset: number
}

/** Keeps the terminal mounted underneath chat so its PTY subscription survives
 *  view toggles while the native surface owns the visible composer. */
export function MobileNativeChatOverlay({
  controller,
  onAttachImage,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  keyboardInset
}: Props): React.JSX.Element | null {
  if (!controller.showNativeChat) {
    return null
  }
  const session = controller.nativeChatSession
  return (
    <View style={styles.overlay}>
      <MobileNativeChatView
        messages={session.messages}
        status={session.status}
        error={session.error}
        agent={controller.nativeChatAgent}
        agentWorking={controller.nativeChatAgentWorking}
        streamingText={controller.nativeChatStreamingText}
        onStop={controller.handleNativeChatStop}
        ask={controller.nativeChatAsk}
        onAnswerAsk={controller.handleNativeChatAnswerAsk}
        onCancelAsk={controller.handleNativeChatCancelAsk}
        question={controller.nativeChatQuestion}
        onAnswerQuestion={controller.handleNativeChatSend}
        permission={controller.nativeChatPermission}
        onRespondPermission={controller.handleNativeChatRespondPermission}
        onOpenFile={controller.handleNativeChatOpenFile}
        hasMore={session.hasMore}
        loadingEarlier={session.loadingEarlier}
        onLoadEarlier={session.loadEarlier}
        onSend={controller.handleNativeChatSend}
        pending={controller.chatPending}
        composerText={controller.chatComposerText}
        onComposerTextChange={controller.setChatComposerText}
        onAttachImage={onAttachImage}
        isAttaching={isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        dictationMode={dictationMode}
        onMicPressIn={onMicPressIn}
        onMicPressOut={onMicPressOut}
        inputLockReason={inputLockReason}
        filePaths={controller.nativeChatFilePaths}
        onNeedFiles={controller.loadNativeChatFiles}
        keyboardInset={keyboardInset}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFillObject
})
