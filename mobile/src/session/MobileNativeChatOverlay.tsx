import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { useCallback, useLayoutEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import type { MobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import type { MobileNativeChatStructuredComposer } from './native-chat/composer/MobileNativeChatComposer'
import { useMobileNativeChatComposerTray } from './native-chat/composer/use-mobile-native-chat-composer-tray'
import { useMobileNativeChatVisualRenderer } from './native-chat/visual/MobileNativeChatVisual'
import { MobileNativeChatVisualContext } from './native-chat/visual/mobile-native-chat-visual-context'
import { MobileNativeChatRootItemSourceContext } from './mobile-native-chat-item-read'
import { useMobileNativeChatMessageDetail } from './native-chat/transcript/use-mobile-native-chat-message-detail'
import {
  MobileNativeChatReplyRevealsContext,
  useMobileNativeChatReplyReveals
} from './native-chat/transcript/mobile-native-chat-reply-reveals'
import { MobileNativeChatRowOverlaysHost } from './native-chat/transcript/MobileNativeChatRowOverlaysHost'
import { nativeChatAskRequiresTerminal } from '../../../src/shared/native-chat-agent-support'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import { MobileNativeChatNoticeContext } from './mobile-native-chat-notice-context'
import type { MobileNativeChatImageSource } from './native-chat/visual/mobile-native-chat-image-preview'

type Props = {
  controller: MobileNativeChatController
  imageSource?: MobileNativeChatImageSource
  activeSessionTabId?: string | null
  onOpenFile: (pathText: string) => void
  images: MobileNativeChatImageAttachments
  structuredComposer?: MobileNativeChatStructuredComposer | null
  onMicPress: (() => void) | undefined
  micActive: boolean
  micStarting: boolean
  micProcessing: boolean
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
  /** The Orca host that runs this chat, named for notices; null when unnamed. */
  hostName: string | null
}

// Keep the terminal subscription and streaming gate above view toggles; the chat list unmounts below this boundary.
export function MobileNativeChatOverlay({
  controller,
  imageSource,
  activeSessionTabId,
  onOpenFile,
  images,
  structuredComposer = null,
  onMicPress,
  micActive,
  micStarting,
  micProcessing,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  sendSurfaceId,
  sessionId,
  getSendCompletionGeneration,
  keyboardInset,
  hostName
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
  const streaming = controller.nativeChatStreamingText ?? null
  const queued = controller.nativeChatQueued
  const composerTray = useMobileNativeChatComposerTray({
    queued: {
      cards: queued.cards,
      onSend: queued.send,
      onDelete: queued.delete,
      onClearAll: queued.clear,
      onEdit: queued.edit,
      editor: queued.editor,
      onMove: queued.move,
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
  const queuedComposerContext = useMemo(
    () => ({
      agent,
      structured: structuredComposer ?? null,
      skillDiscovery: controller.nativeChatSkills,
      onNeedSkills: controller.loadNativeChatSkills,
      filePaths: controller.nativeChatFilePaths,
      onNeedFiles: controller.loadNativeChatFiles,
      onError: (message: string) => controller.reportQueuedEditError?.(message),
      onMicPress,
      micActive,
      micStarting,
      micProcessing,
      dictationMode,
      onMicPressIn,
      onMicPressOut
    }),
    [
      agent,
      structuredComposer,
      controller.nativeChatSkills,
      controller.loadNativeChatSkills,
      controller.nativeChatFilePaths,
      controller.loadNativeChatFiles,
      controller.reportQueuedEditError,
      onMicPress,
      micActive,
      micStarting,
      micProcessing,
      dictationMode,
      onMicPressIn,
      onMicPressOut
    ]
  )
  const noticeNames = useMemo(
    () => ({ hostName, ...(agent ? { agentName: tuiAgentDisplayName(agent) ?? agent } : {}) }),
    [hostName, agent]
  )
  if (!controller.showNativeChat) {
    return null
  }
  return (
    <MobileNativeChatRowOverlaysHost
      conversation={{ surfaceId: sendSurfaceId, sessionId }}
      imageSource={imageSource}
    >
      <MobileQueuedMessageComposerContext.Provider value={queuedComposerContext}>
        <View style={styles.overlay}>
          <MobileNativeChatVisualContext.Provider value={visuals}>
            <MobileNativeChatRootItemSourceContext.Provider value={detailSource}>
              <MobileNativeChatReplyRevealsContext.Provider value={replyReveals}>
                <MobileNativeChatNoticeContext.Provider value={noticeNames}>
                  <MobileNativeChatView
                    messages={session.messages}
                    folded={folded}
                    status={session.status}
                    error={session.error}
                    readFailedFinally={session.readFailedFinally === true}
                    agent={controller.nativeChatAgent}
                    sessionLive={controller.nativeChatSessionLive}
                    agentWorking={controller.nativeChatTurnActive}
                    awaitingInput={controller.nativeChatAwaitingInput}
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
                    composerScopeKey={controller.chatComposerScopeKey}
                    draftKey={controller.chatDraftKey}
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
                    micStarting={micStarting}
                    micProcessing={micProcessing}
                    dictationMode={dictationMode}
                    onMicPressIn={onMicPressIn}
                    onMicPressOut={onMicPressOut}
                    inputLockReason={inputLockReason}
                    sendErrorMessage={sendErrorMessage}
                    onClearSendError={onClearSendError}
                    filePaths={controller.nativeChatFilePaths}
                    onNeedFiles={controller.loadNativeChatFiles}
                    skillDiscovery={controller.nativeChatSkills}
                    onNeedSkills={controller.loadNativeChatSkills}
                    sessionOptions={controller.nativeChatSessionOptions}
                    structuredComposer={structuredComposer}
                    keyboardInset={keyboardInset}
                  />
                </MobileNativeChatNoticeContext.Provider>
              </MobileNativeChatReplyRevealsContext.Provider>
            </MobileNativeChatRootItemSourceContext.Provider>
          </MobileNativeChatVisualContext.Provider>
        </View>
      </MobileQueuedMessageComposerContext.Provider>
    </MobileNativeChatRowOverlaysHost>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFillObject
})
