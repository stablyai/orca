import { MobileQueuedMessageComposerContext } from './input/mobile-queued-message-composer-context'
import { Activity, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import { useMobileNativeChatProjection } from './transcript/use-mobile-native-chat-projection'
import { nativeChatDockedTaskList } from '../../../../src/shared/native-chat/input/native-chat-task-list-state'
import type { MobileNativeChatImageAttachments } from './composer/use-mobile-native-chat-image-attachments'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import type { MobileNativeChatStructuredComposer } from './composer/mobile-native-chat-structured-composer'
import { useMobileNativeChatComposerTray } from './composer/use-mobile-native-chat-composer-tray'
import { useMobileNativeChatVisualRenderer } from './visual/MobileNativeChatVisual'
import { MobileNativeChatVisualContext } from './visual/mobile-native-chat-visual-context'
import { MobileNativeChatRootItemSourceContext } from './transcript/mobile-native-chat-item-read'
import { useMobileNativeChatMessageDetail } from './transcript/use-mobile-native-chat-message-detail'
import {
  MobileNativeChatReplyRevealsContext,
  useMobileNativeChatReplyReveals
} from './transcript/mobile-native-chat-reply-reveals'
import { MobileNativeChatRowOverlaysHost } from './transcript/MobileNativeChatRowOverlaysHost'
import { nativeChatAskRequiresTerminal } from '../../../../src/shared/native-chat/native-chat-agent-support'
import { tuiAgentDisplayName } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { MobileNativeChatNoticeContext } from './transcript/mobile-native-chat-notice-context'
import type { MobileNativeChatImageSource } from './visual/mobile-native-chat-image-preview'
import type { MobileNativeChatHostOutage } from './mobile-native-chat-host-outage'
import { useMobileNativeChatMarkdownLinks } from './use-mobile-native-chat-markdown-links'
import { MobileMarkdownLinksContext } from '../../components/mobile-markdown-links-context'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

type Props = {
  controller: MobileNativeChatController
  imageSource?: MobileNativeChatImageSource
  /** The workspace's folder on its host; null until known, which leaves chat paths unchecked. */
  worktreePath: string | null
  connState: ConnectionState
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
  /** Opens the accounts of the host that runs this chat; absent when the phone can't reach them. */
  onOpenAccounts?: () => void
  /** Offered for tapped links; absent where the host can't open a browser tab. */
  onOpenUrlInOrca?: (url: string) => void
  /** Opens a host terminal tab in this chat's workspace running `command`. */
  onRunInTerminal: (command: string) => void
  hostOutage?: MobileNativeChatHostOutage | null
}

// Hide the last chat behind its terminal instead of unmounting it, so returning keeps its rows and parsed markdown.
export function MobileNativeChatOverlay(props: Props): React.JSX.Element | null {
  const shown = props.controller.showNativeChat
  // While hidden, the live lane is starved to an empty chat; draw the last shown props so the hidden tree does no work.
  const [lastShown, setLastShown] = useState<Props | null>(null)
  if (shown && lastShown !== props) {
    setLastShown(props)
  }
  const drawn = shown ? props : lastShown
  // The same element while hidden lets React skip the hidden tree.
  const content = useMemo(
    () => (drawn ? <MobileNativeChatOverlayContent {...drawn} /> : null),
    [drawn]
  )
  if (!content) {
    return null
  }
  return <Activity mode={shown ? 'visible' : 'hidden'}>{content}</Activity>
}

function MobileNativeChatOverlayContent({
  controller,
  imageSource,
  worktreePath,
  connState,
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
  hostName,
  onOpenUrlInOrca,
  onRunInTerminal,
  hostOutage = null,
  onOpenAccounts
}: Props): React.JSX.Element {
  const session = controller.nativeChatSession
  const agent = controller.nativeChatAgent ?? ''
  const fullContent = useMobileNativeChatMessageDetail(
    session.messages,
    controller.nativeChatItemSource
  )
  const folded = useMobileNativeChatProjection(
    fullContent.messages,
    agent,
    [
      sendSurfaceId,
      sessionId,
      controller.nativeChatItemSource?.client,
      controller.nativeChatItemSource?.sessionId
    ],
    controller.nativeChatShowsCiResultLines
  )
  const taskList = useMemo(() => nativeChatDockedTaskList(folded), [folded])
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
      steerHeld: controller.nativeChatTurnIndicator?.stopping === true,
      agentWorking: controller.nativeChatTurnActive
    },
    taskList,
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
      interactionModeSupported: controller.nativeChatSessionOptions?.controller.snapshot.some(
        (entry) => entry.id === 'interactionMode'
      ),
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
      controller.nativeChatSessionOptions,
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
  // Why a ref: rows read this through context, and the route's callback changes every render.
  const runInTerminalRef = useRef(onRunInTerminal)
  useLayoutEffect(() => {
    runInTerminalRef.current = onRunInTerminal
  }, [onRunInTerminal])
  const runInTerminal = useCallback((command: string) => runInTerminalRef.current(command), [])
  const t = useMobileTranslation()
  const continuation = controller.nativeChatInterruptedContinue
  const noticeView = useMemo(
    () => ({
      hostName,
      ...(agent ? { agentName: tuiAgentDisplayName(agent) ?? agent } : {}),
      onRunInTerminal: runInTerminal,
      usageLimit: controller.nativeChatUsageLimit,
      ...(onOpenAccounts ? { openAccounts: onOpenAccounts } : {}),
      ...(continuation
        ? {
            continuation: {
              ...continuation,
              // A Continue tap is the person's newer action, so it clears the composer's error.
              continueNow: () => {
                onClearSendError()
                continuation.continueNow()
              }
            }
          }
        : {})
    }),
    [
      hostName,
      agent,
      continuation,
      onClearSendError,
      runInTerminal,
      controller.nativeChatUsageLimit,
      onOpenAccounts
    ]
  )
  const markdownLinks = useMobileNativeChatMarkdownLinks({
    enabled: controller.showNativeChat,
    client: imageSource?.client ?? null,
    connState,
    worktreeId: imageSource?.worktreeId ?? '',
    worktreePath,
    isWorking: controller.nativeChatTurnActive
  })
  const continueFailed = sendErrorMessage === null && continuation?.failed === true
  return (
    <MobileNativeChatRowOverlaysHost
      conversation={{ surfaceId: sendSurfaceId, sessionId }}
      imageSource={imageSource}
      onOpenUrlInOrca={onOpenUrlInOrca}
      onOpenFile={onOpenFile}
      rewind={controller.nativeChatRewind}
    >
      <MobileMarkdownLinksContext.Provider value={markdownLinks}>
        <MobileQueuedMessageComposerContext.Provider value={queuedComposerContext}>
          <View style={styles.overlay}>
            <MobileNativeChatVisualContext.Provider value={visuals}>
              <MobileNativeChatRootItemSourceContext.Provider value={detailSource}>
                <MobileNativeChatReplyRevealsContext.Provider value={replyReveals}>
                  <MobileNativeChatNoticeContext.Provider value={noticeView}>
                    <MobileNativeChatView
                      messages={session.messages}
                      folded={folded}
                      status={session.status}
                      error={session.error}
                      readFailedFinally={session.readFailedFinally === true}
                      clearing={session.clearing === true}
                      agent={controller.nativeChatAgent}
                      sessionLive={controller.nativeChatSessionLive}
                      agentWorking={controller.nativeChatTurnActive}
                      awaitingInput={controller.nativeChatAwaitingInput}
                      canStop={controller.nativeChatCanStop}
                      sendFollowUp={controller.nativeChatSendFollowUp}
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
                      askPending={controller.nativeChatAskPending}
                      askSendSource={controller.nativeChatAskSendSource}
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
                      onPasteImages={
                        controller.nativeChatAcceptsImages
                          ? (paste) => void images.attachImage(paste)
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
                      hostOutage={hostOutage}
                      sendErrorMessage={
                        continueFailed
                          ? t(
                              'chat.interruptedContinue.failed',
                              "Couldn't continue this chat. Try again, or send a message."
                            )
                          : sendErrorMessage
                      }
                      onDismissSendError={continueFailed ? continuation?.dismissFailure : undefined}
                      onClearSendError={onClearSendError}
                      filePaths={controller.nativeChatFilePaths}
                      onNeedFiles={controller.loadNativeChatFiles}
                      skillDiscovery={controller.nativeChatSkills}
                      onNeedSkills={controller.loadNativeChatSkills}
                      sessionOptions={controller.nativeChatSessionOptions}
                      contextUsage={controller.nativeChatContextUsage}
                      structuredComposer={structuredComposer}
                      keyboardInset={keyboardInset}
                    />
                  </MobileNativeChatNoticeContext.Provider>
                </MobileNativeChatReplyRevealsContext.Provider>
              </MobileNativeChatRootItemSourceContext.Provider>
            </MobileNativeChatVisualContext.Provider>
          </View>
        </MobileQueuedMessageComposerContext.Provider>
      </MobileMarkdownLinksContext.Provider>
    </MobileNativeChatRowOverlaysHost>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFill
})
