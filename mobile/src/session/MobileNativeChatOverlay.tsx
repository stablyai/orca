import { useCallback, useLayoutEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import type { MobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import type { MobileNativeChatStructuredComposer } from './native-chat/composer/MobileNativeChatComposer'
import { useMobileNativeChatStreamingBubble } from './native-chat/use-mobile-native-chat-streaming-bubble'
import { useMobileNativeChatComposerTray } from './native-chat/composer/use-mobile-native-chat-composer-tray'
import { useMobileNativeChatVisualRenderer } from './MobileNativeChatVisual'
import { MobileNativeChatVisualContext } from './mobile-native-chat-visual-context'
import { MobileNativeChatRootItemSourceContext } from './mobile-native-chat-item-read'
import { useMobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'
import {
  MobileNativeChatReplyRevealsContext,
  useMobileNativeChatReplyReveals
} from './mobile-native-chat-reply-reveals'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import { nativeChatAskRequiresTerminal } from '../../../src/shared/native-chat-agent-support'

type Props = {
  controller: MobileNativeChatController
  activeSessionTabId?: string | null
  onOpenFile: (pathText: string) => void
  images: MobileNativeChatImageAttachments
  structuredComposer?: MobileNativeChatStructuredComposer | null
  onMicPress: (() => void) | undefined
  micActive: boolean
  dictationMode: string | undefined
  onMicPressIn: () => void
  onMicPressOut: () => void
  inputLockReason: MobileNativeChatInputLockReason | null
  sendErrorMessage: string | null
  onClearSendError: () => void
  /** Stable host/worktree/tab identity for accepted-send completion fencing. */
  sendSurfaceId: string
  sessionId: string | null
  getSendCompletionGeneration: () => number
  keyboardInset: number
}

// Keep the terminal subscription and streaming gate above view toggles; the chat list unmounts below this boundary.
export function MobileNativeChatOverlay({
  controller,
  activeSessionTabId,
  onOpenFile,
  images,
  structuredComposer = null,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  sendSurfaceId,
  sessionId,
  getSendCompletionGeneration,
  keyboardInset
}: Props): React.JSX.Element | null {
  const session = controller.nativeChatSession
  const agent = controller.nativeChatAgent ?? ''
  const fullContent = useMobileNativeChatMessageDetail(
    session.messages,
    controller.nativeChatItemSource
  )
  const folded = useMemo(
    () => foldMobileNativeChatMessages(fullContent.messages, agent),
    [fullContent.messages, agent]
  )
  const streaming = useMobileNativeChatStreamingBubble(
    folded,
    controller.nativeChatStreamingText,
    controller.nativeChatStreamScopeKey,
    controller.nativeChatStreamLive
  )
  const queued = controller.nativeChatQueued
  const composerTray = useMobileNativeChatComposerTray({
    queued: {
      cards: queued.cards,
      onSend: queued.send,
      onDelete: queued.delete,
      onClearAll: queued.clear,
      onEdit: queued.edit,
      editor: queued.editor,
      pause: queued.pause,
      onResume: queued.resume,
      sessionKey: queued.sessionKey,
      // Hold steering while Stop ends the turn; use the session’s single display-status decision.
      steerHeld: controller.nativeChatTurnIndicator?.stopping === true
    },
    backgroundTasks: controller.nativeChatBackgroundTasks
  })
  const visuals = useMobileNativeChatVisualRenderer(controller.nativeChatVisualSource)
  const replyReveals = useMobileNativeChatReplyReveals(folded, streaming !== null, sendSurfaceId)
  const itemSource = controller.nativeChatItemSource
  const committedDetail = useMemo(
    () => ({ current: fullContent.detail }),
    [itemSource?.client, itemSource?.sessionId]
  )
  useLayoutEffect(() => {
    committedDetail.current = fullContent.detail
  }, [committedDetail, fullContent.detail])
  const load = useCallback(
    async (id: string) => {
      if (!committedDetail.current) {
        throw new Error('Message unavailable')
      }
      await committedDetail.current.load(id)
    },
    [committedDetail]
  )
  const detailSource = useMemo(
    () =>
      itemSource
        ? {
            ...itemSource,
            messageDetail: fullContent.detail ? { ...fullContent.detail, load } : null
          }
        : null,
    [itemSource, fullContent.detail, load]
  )
  if (!controller.showNativeChat) {
    return null
  }
  return (
    <MobileNativeChatRowOverlaysHost conversation={{ surfaceId: sendSurfaceId, sessionId }}>
      <View style={styles.overlay}>
        <MobileNativeChatVisualContext.Provider value={visuals}>
          <MobileNativeChatRootItemSourceContext.Provider value={detailSource}>
            <MobileNativeChatReplyRevealsContext.Provider value={replyReveals}>
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
                receipts={controller.nativeChatReceipts}
                actionablePromptIds={controller.nativeChatActionablePromptIds}
                streaming={streaming}
                onStop={controller.handleNativeChatStop}
                ask={controller.nativeChatAsk}
                askKey={controller.nativeChatAskKey}
                promptKey={controller.nativeChatPromptKey}
                onDismissAsk={controller.dismissNativeChatAsk}
                onAnswerAsk={controller.handleNativeChatAnswerAsk}
                askRequiresTerminal={
                  !controller.nativeChatStructured && nativeChatAskRequiresTerminal(agent)
                }
                onAnswerInTerminal={
                  activeSessionTabId
                    ? () => controller.setTabView(activeSessionTabId, 'terminal')
                    : undefined
                }
                onCancelAsk={controller.handleNativeChatCancelAsk}
                onCancelPrompt={controller.handleNativeChatCancelPrompt}
                onCollapseAsk={controller.collapseNativeChatAsk}
                onCollapsePrompt={controller.collapseNativeChatPrompt}
                collapsedPrompt={controller.nativeChatCollapsedPrompt}
                question={controller.nativeChatQuestion}
                onAnswerQuestion={controller.handleNativeChatQuestionAnswer}
                permission={controller.nativeChatPermission}
                onRespondPermission={controller.handleNativeChatRespondPermission}
                composerTray={composerTray}
                onOpenFile={onOpenFile}
                hasMore={session.hasMore}
                olderPages={session.olderPages}
                onLoadEarlier={session.loadEarlier}
                onSend={images.sendNativeChat}
                sendSurfaceId={sendSurfaceId}
                getSendCompletionGeneration={getSendCompletionGeneration}
                getComposerEditGeneration={controller.getChatComposerEditGeneration}
                pending={controller.chatPending}
                imagePreviewsByMessageId={controller.chatImagePreviewsByMessageId}
                composerText={controller.chatComposerText}
                onComposerTextChange={controller.setChatComposerText}
                onAttachImage={
                  controller.nativeChatAcceptsImages
                    ? () => void images.attachImage('library')
                    : undefined
                }
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
                structuredComposer={structuredComposer}
                keyboardInset={keyboardInset}
              />
            </MobileNativeChatReplyRevealsContext.Provider>
          </MobileNativeChatRootItemSourceContext.Provider>
        </MobileNativeChatVisualContext.Provider>
      </View>
    </MobileNativeChatRowOverlaysHost>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFillObject
})
