import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import type { MobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import { useMobileNativeChatStreamingBubble } from './use-mobile-native-chat-streaming-bubble'
import { useMobileNativeChatQueuedSlot } from './use-mobile-native-chat-queued-slot'

type Props = {
  controller: MobileNativeChatController
  /** Opens a tapped file reference (worktree-relative or absolute, optional
   *  :line(:col) suffix) through the shared tap-to-open flow. */
  onOpenFile: (pathText: string) => void
  /** Native-chat image attachments: picking adds a composer chip, and sending
   *  rides the pending images along with the message text (desktop parity). */
  images: MobileNativeChatImageAttachments
  onMicPress: () => void
  micActive: boolean
  dictationMode: string | undefined
  onMicPressIn: () => void
  onMicPressOut: () => void
  inputLockReason: MobileNativeChatInputLockReason | null
  /** Latest send failure, rendered inline above the composer. */
  sendErrorMessage: string | null
  /** Drops that failure once a later send succeeds. */
  onClearSendError: () => void
  /** Stable host/worktree/tab identity for accepted-send completion fencing. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation for accepted-send fencing. */
  getSendCompletionGeneration: () => number
  keyboardInset: number
}

/** Keeps the terminal mounted underneath chat so its PTY subscription survives
 *  view toggles while the native surface owns the visible composer. Also owns
 *  the streaming gate: this component stays mounted across those toggles, while
 *  the chat list below it does not. */
export function MobileNativeChatOverlay({
  controller,
  onOpenFile,
  images,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  sendSurfaceId,
  getSendCompletionGeneration,
  keyboardInset
}: Props): React.JSX.Element | null {
  const session = controller.nativeChatSession
  const folded = useMemo(() => foldMobileNativeChatMessages(session.messages), [session.messages])
  const streaming = useMobileNativeChatStreamingBubble(
    folded,
    controller.nativeChatStreamingText,
    controller.nativeChatStreamScopeKey,
    controller.nativeChatStreamLive
  )
  const queued = controller.nativeChatQueued
  const queuedSlot = useMobileNativeChatQueuedSlot({
    cards: queued.cards,
    onSend: queued.send,
    onDelete: queued.delete,
    onEdit: queued.edit,
    pause: queued.pause,
    onResume: queued.resume,
    sessionKey: queued.sessionKey,
    // Nothing steers into a turn a Stop is ending; the host holds such a send until it ends.
    // The indicator's `stopping` is the display status, decided once in the session hook.
    steerHeld: controller.nativeChatTurnIndicator?.stopping === true
  })
  if (!controller.showNativeChat) {
    return null
  }
  return (
    <View style={styles.overlay}>
      <MobileNativeChatView
        messages={session.messages}
        folded={folded}
        status={session.status}
        error={session.error}
        readFailedFinally={session.readFailedFinally === true}
        agent={controller.nativeChatAgent}
        agentWorking={controller.nativeChatAgentWorking}
        canStop={controller.nativeChatCanStop}
        structuredActivityUi={controller.nativeChatStructured}
        turnIndicator={controller.nativeChatTurnIndicator}
        workingStartedAt={controller.nativeChatWorkingStartedAt}
        settledTurns={controller.nativeChatSettledTurns}
        turnJournal={controller.nativeChatTurnJournal}
        streaming={streaming}
        onStop={controller.handleNativeChatStop}
        ask={controller.nativeChatAsk}
        askKey={controller.nativeChatAskKey}
        promptKey={controller.nativeChatPromptKey}
        onDismissAsk={controller.dismissNativeChatAsk}
        onAnswerAsk={controller.handleNativeChatAnswerAsk}
        onCancelAsk={controller.handleNativeChatCancelAsk}
        onCancelPrompt={controller.handleNativeChatCancelPrompt}
        onCollapseAsk={controller.collapseNativeChatAsk}
        onCollapsePrompt={controller.collapseNativeChatPrompt}
        collapsedPrompt={controller.nativeChatCollapsedPrompt}
        question={controller.nativeChatQuestion}
        onAnswerQuestion={controller.handleNativeChatQuestionAnswer}
        permission={controller.nativeChatPermission}
        onRespondPermission={controller.handleNativeChatRespondPermission}
        queuedSlot={queuedSlot}
        onOpenFile={onOpenFile}
        hasMore={session.hasMore}
        loadingEarlier={session.loadingEarlier}
        onLoadEarlier={session.loadEarlier}
        onSend={images.sendNativeChat}
        sendSurfaceId={sendSurfaceId}
        getSendCompletionGeneration={getSendCompletionGeneration}
        getComposerEditGeneration={controller.getChatComposerEditGeneration}
        pending={controller.chatPending}
        imagePreviewsByMessageId={controller.chatImagePreviewsByMessageId}
        composerText={controller.chatComposerText}
        onComposerTextChange={controller.setChatComposerText}
        onAttachImage={() => void images.attachImage('library')}
        attachments={images.attachments}
        onRemoveAttachment={images.removeAttachment}
        isAttaching={images.isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        dictationMode={dictationMode}
        onMicPressIn={onMicPressIn}
        onMicPressOut={onMicPressOut}
        inputLockReason={inputLockReason}
        sendErrorMessage={sendErrorMessage}
        onClearSendError={onClearSendError}
        filePaths={controller.nativeChatFilePaths}
        onNeedFiles={controller.loadNativeChatFiles}
        sessionOptions={controller.nativeChatSessionOptions}
        keyboardInset={keyboardInset}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFillObject
})
