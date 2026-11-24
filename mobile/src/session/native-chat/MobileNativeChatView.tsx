import { mobileWaitingAgentMailRows } from './transcript/agent-messages/MobileWaitingAgentMailRows'
import { MobileBotFirstScreen, useMobileBotFirstScreen } from './MobileBotFirstScreen'
import { MobileBotCardSendContext } from './transcript/bot-cards/mobile-bot-card-host'
import { mobileNativeChatOtherBotCard } from './transcript/bot-cards/mobile-native-chat-bot-cards'
import { MobileMarkdownBotCardContext } from '../../components/markdown/blocks/mobile-markdown-bot-card-context'
import type { NativeChatDirectiveBotCard } from '../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import type { MobileNativeChatViewProps } from './mobile-native-chat-view-props'
import { useMobileNativeChatItemNavigation } from './transcript/viewport/use-mobile-native-chat-item-navigation'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { useCallback, useContext, useMemo } from 'react'
import { MobileNativeChatBotIdentityContext } from './mobile-native-chat-bot-identity'
import { nativeChatTaskListPredecessors } from '../../../../src/shared/native-chat/input/task-lists/native-chat-task-list-history'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './transcript/viewport/mobile-native-chat-disclosure-store'
import { type NativeScrollEvent, type NativeSyntheticEvent, View } from 'react-native'
import { MobileNativeChatSendErrorBanner } from './status/MobileNativeChatSendErrorBanner'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileNativeChatInputLockStatus } from './composer/field/MobileNativeChatInputLockStatus'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { styles } from './mobile-native-chat-view-styles'
import { MobileNativeChatComposerMenuHost } from './composer/menus/MobileNativeChatComposerMenuHost'
import { MobileNativeChatEmptyStateView } from './transcript/viewport/MobileNativeChatEmptyStateView'
import { mobileNativeChatListFooter } from './transcript/viewport/mobile-native-chat-list-footer'
import { mobileNativeChatLiveStatus } from './transcript/viewport/mobile-native-chat-live-status'
import { mobileNativeChatListHeader } from './transcript/viewport/mobile-native-chat-list-header'
import { paneEmpty } from './transcript/projection/mobile-native-chat-render-data'
import { useMobileNativeChatTransientData } from './transcript/projection/use-mobile-native-chat-transient-data'
import { useMobileNativeChatRowKeys } from './transcript/projection/mobile-native-chat-row-keys'
import { useMobileNativeChatPinchGesture } from './transcript/viewport/mobile-native-chat-pinch-zoom'
import { useNativeChatTextSettings } from './preferences/native-chat-text-settings'
import { useMobileNativeChatTailFollow } from './transcript/viewport/use-mobile-native-chat-tail-follow'
import { useMobileNativeChatTurnDisclosure } from './transcript/turn-state/use-mobile-native-chat-turn-disclosure'
import { mobileNativeChatComposerPlaceholder } from './composer/field/use-mobile-native-chat-input-lease'
import { MobileNativeChatFloatingControls } from './lower-region/MobileNativeChatFloatingControls'
import { MobileNativeChatDraftComposer } from './composer/MobileNativeChatDraftComposer'
import { MobileNativeChatPromptCard } from './input/prompts/MobileNativeChatPromptCard'
import { useMobileNativeChatWorkerApprovalSlot } from './input/prompts/MobileNativeChatWorkerApproval'
import {
  MobileWorkerApprovalReceiptsContext,
  useMobileWorkerApprovalReceiptPlacement
} from './transcript/messages/MobileNativeChatWorkerApprovalReceipts'
import type { MobileNativeChatMicProps } from './composer/dictation/MobileNativeChatComposerMic'
import { useMobileNativeChatPromptInputOwner } from './input/prompts/use-mobile-native-chat-prompt-input-owner'
import {
  NO_COMPOSER_TRAY,
  type ComposerTrayProps
} from './composer/menus/use-mobile-native-chat-composer-tray'
import { MobileNativeChatScrollRootsBoundary } from './transcript/viewport/MobileNativeChatScrollRootsBoundary'
import { MobileNativeChatRowList } from './transcript/MobileNativeChatRowList'
import { useMobileNativeChatRowRenderer } from './transcript/projection/use-mobile-native-chat-row-renderer'
import { MobileNativeChatOpenFileContext } from './links/mobile-native-chat-open-file-context'
import { MobileNativeChatLowerRegion } from './lower-region/MobileNativeChatLowerRegion'
import { MobileNativeChatQueueAbovePromptContext } from './lower-region/mobile-native-chat-lower-region-context'
import { MobileNativeChatPromptStrip } from './input/prompts/MobileNativeChatPromptStrip'
import { MobileNativeChatOfflineQueue } from './input/queued-messages/MobileNativeChatOfflineQueue'
import { useMobileNativeChatOfflineQueue } from './composer/delivery/use-mobile-native-chat-offline-sends'

export type { MobileNativeChatInputLockReason } from './mobile-native-chat-view-props'

type Props = ComposerTrayProps & MobileNativeChatMicProps & MobileNativeChatViewProps

export function MobileNativeChatView({
  itemNavigation,
  messages,
  folded,
  status,
  error,
  readFailedFinally = false,
  clearing = false,
  agent,
  sessionLive,
  agentWorking,
  canStop = agentWorking,
  sendFollowUp,
  awaitingInput = null,
  structuredActivityUi = false,
  turnIndicator = null,
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  transcriptLoading = false,
  receipts = null,
  actionablePromptIds,
  onStop,
  streaming,
  hasMore,
  olderPages = 'idle',
  onLoadEarlier,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  pending,
  imagePreviewsByMessageId,
  draftKey,
  composerScopeKey,
  onComposerTextChange,
  onAttachImage,
  onPasteImages,
  attachments,
  onRemoveAttachment,
  isAttaching,
  onMicPress,
  micActive,
  micStarting,
  micProcessing,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  hostOutage = null,
  sendErrorMessage,
  onClearSendError,
  onDismissSendError,
  filePaths,
  onNeedFiles,
  fileReference,
  skillDiscovery,
  onNeedSkills,
  sessionOptions,
  contextUsage = null,
  structuredComposer: structured = null,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  askPending,
  askSendSource,
  askRequiresTerminal = false,
  onAnswerInTerminal,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
  question,
  onAnswerQuestion,
  permission,
  workerApprovals,
  promptKey,
  onRespondPermission,
  composerTray: { content: trayContent, composerInputRef: inputRef, ...tray } = NO_COMPOSER_TRAY,
  onOpenFile,
  keyboardInset = 0,
  listScopeKey = sendSurfaceId,
  hideTranscriptChrome = false,
  activityBar = null
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const rootStyle = [styles.root, { paddingBottom: bottomPad }]
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()
  const { font, lineSpacing } = useNativeChatTextSettings()

  const data = useMobileNativeChatTransientData(
    { folded, streaming, pending, imagePreviewsByMessageId },
    sendSurfaceId
  )
  const tail = useMobileNativeChatTailFollow({ hasItems: data.length > 0, scopeKey: listScopeKey })
  const { jumpToTail, recordScrollMetrics, scrollMayLoadEarlier } = tail

  // Lock only terminal-backed Send: it can answer an agent prompt, while drafting is harmless and structured sends queue.
  const promptShown = !collapsedPrompt && (ask ?? permission ?? question) != null
  const expandedPromptOwnsSend = !structuredActivityUi && promptShown
  const offlineQueue = useMobileNativeChatOfflineQueue({
    scope: draftKey,
    inputLockReason: inputLockReason ?? null,
    held: structuredActivityUi
      ? status !== 'ready'
      : (ask ?? permission ?? question ?? collapsedPrompt ?? awaitingInput) != null,
    send: onSend
  })
  const handleSend = useCallback(
    async (...send: Parameters<typeof onSend>): Promise<boolean> => {
      // Retire the previous notice before this action can report a new one.
      onClearSendError?.()
      const accepted = await offlineQueue.send(...send)
      if (!accepted) {
        return false
      }
      jumpToTail()
      return true
    },
    [offlineQueue.send, onClearSendError, jumpToTail]
  )

  // A bot card's answer goes to the agent as if typed.
  const sendFromCard = useCallback((text: string) => handleSend(text), [handleSend])
  const drawReplyCard = useCallback(
    (card: NativeChatDirectiveBotCard) =>
      mobileNativeChatOtherBotCard(card, {
        cardId: '',
        timestamp: null,
        fallback: '',
        fontScale: 1
      }),
    []
  )
  const loadEarlier = useCallback(() => onLoadEarlier?.(), [onLoadEarlier])
  // After failure require a tap; automatic near-top retries could spin forever.
  const loadEarlierNearTop = hasMore && olderPages === 'idle' ? loadEarlier : undefined

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      recordScrollMetrics(e.nativeEvent)
      // Only reader drags trigger native pagination; tail-pin offsets may also look near-top.
      if (contentOffset.y < 60 && scrollMayLoadEarlier()) {
        loadEarlierNearTop?.()
      }
    },
    [loadEarlierNearTop, scrollMayLoadEarlier, recordScrollMetrics]
  )

  const turnBot = useContext(MobileNativeChatBotIdentityContext)
  const firstScreen = useMobileBotFirstScreen(
    messages,
    transcriptLoading ? null : turnJournal,
    agentWorking === true
  )
  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: true,
    isWorking: hideTranscriptChrome ? false : agentWorking === true,
    workingStartedAt,
    settledTurns,
    turnJournal,
    thinking: hideTranscriptChrome ? false : turnIndicator?.thinking === true,
    activityText: hideTranscriptChrome ? null : (turnIndicator?.activityText ?? null),
    stopping: hideTranscriptChrome ? false : turnIndicator?.stopping === true,
    lineYields: hideTranscriptChrome
      ? false
      : ask != null || permission != null || question != null,
    receipts,
    scopeKey: sendSurfaceId,
    showsTurnDiffs: turnBot === null
  })

  const workerReceipts = useMobileWorkerApprovalReceiptPlacement(turns, workerApprovals?.receipts)
  const rowKeys = useMobileNativeChatRowKeys(folded, messages, listScopeKey, turns.presentation)
  const itemJump = useMobileNativeChatItemNavigation({
    navigation: itemNavigation,
    rows: turns.listMessages,
    rowKeys,
    ready: status === 'ready',
    hasMore,
    olderPages,
    loadEarlier,
    tail
  })
  const disclosures = useMobileNativeChatDisclosures(sendSurfaceId)
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(data), [data])
  const renderItem = useMobileNativeChatRowRenderer({
    scope: sendSurfaceId,
    rowKeyOf: rowKeys.keyOf,
    runOwners: rowKeys.runOwners,
    taskListPredecessors,
    fontScale,
    structuredActivityUi,
    turns,
    turnJournal,
    agent,
    receipts,
    actionablePromptIds
  })

  const liveStatus = mobileNativeChatLiveStatus({
    hidden: hideTranscriptChrome,
    awaitingInput,
    line: turns.liveLine,
    onToggleReasoning: turns.onToggleReasoning,
    fontScale
  })

  const header = mobileNativeChatListHeader(hasMore, olderPages, loadEarlier)
  // Changing text size, face or spacing relays out every row, so preserve the page’s reading anchor.
  const layoutKey = `${fontScale}:${font}:${lineSpacing}`
  const mailRows = mobileWaitingAgentMailRows(tray.waitingAgentMail, fontScale, tail.viewport)
  const footer = mobileNativeChatListFooter(liveStatus, turns.waitingRows, renderItem, mailRows)
  const emptyState = paneEmpty(hideTranscriptChrome, status, agent, error, sessionLive, clearing)

  const composerPlaceholder = mobileNativeChatComposerPlaceholder(
    offlineQueue.lockReason,
    turnIndicator?.afterStop
  )
  const workerApproval = useMobileNativeChatWorkerApprovalSlot(
    workerApprovals,
    (ask ?? permission ?? question ?? collapsedPrompt) != null,
    onDismissSendError ? null : sendErrorMessage
  )
  const promptOwnsInput = useMobileNativeChatPromptInputOwner(
    {
      // A collapsed structured question still holds the input: the agent waits on that answer alone.
      promptShown: promptShown || !!collapsedPrompt?.holdsInput || workerApproval.card !== null,
      ask,
      askRequiresTerminal,
      permission,
      micActive,
      micProcessing
    },
    inputRef
  )
  // A failed answer shows on the open card that took the composer's place; a dismissable one stays over it.
  const onCard = promptOwnsInput && !collapsedPrompt && !onDismissSendError
  const [notice, banner] = onCard ? [sendErrorMessage, null] : [null, sendErrorMessage]
  const emptyStateView = emptyState ? <MobileNativeChatEmptyStateView copy={emptyState} /> : null

  // The queue sits above a shown prompt card in a closed box, rather than tucking into the composer.
  const lowerContent = (
    <>
      {activityBar}
      <MobileNativeChatPromptStrip prompt={collapsedPrompt ?? workerApproval.strip} />
      <MobileNativeChatInputLockStatus
        lockReason={offlineQueue.lockReason}
        waitingText={composerPlaceholder}
        hostOutage={hostOutage}
      />
      <MobileNativeChatSendErrorBanner message={banner} onDismiss={onDismissSendError} />
      <MobileNativeChatQueueAbovePromptContext value={promptShown}>
        {trayContent}
        <MobileNativeChatOfflineQueue queue={offlineQueue} />
      </MobileNativeChatQueueAbovePromptContext>
      {workerApproval.card}
      <MobileNativeChatPromptCard
        key={promptKey ?? undefined}
        answering={promptOwnsInput && keyboardInset > 0}
        {...{ askPending, askSendSource, ask, askKey, onDismissAsk, onAnswerAsk }}
        {...{ onCancelAsk, onCancelPrompt, onCollapseAsk }}
        requiresTerminal={askRequiresTerminal}
        {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
        {...{ onAnswerInTerminal, collapsedPrompt, notice }}
      />
      <View style={promptOwnsInput ? styles.hidden : undefined}>
        <MobileNativeChatDraftComposer
          draftScopeKey={composerScopeKey}
          structured={structuredActivityUi ? structured : null}
          draftKey={draftKey}
          onChangeText={onComposerTextChange}
          onSend={handleSend}
          sendSurfaceId={sendSurfaceId}
          {...{ getSendCompletionGeneration, getComposerEditGeneration, inputRef, sendFollowUp }}
          steerHead={tray.steerHead}
          {...{ agent, sessionOptions, contextUsage }}
          {...{ onAttachImage, onPasteImages, attachments, onRemoveAttachment }}
          {...{ isAttaching, onMicPress, micActive, micStarting, micProcessing }}
          {...{ dictationMode, onMicPressIn, onMicPressOut }}
          {...offlineQueue.composerLock}
          sendDisabled={expandedPromptOwnsSend}
          placeholder={composerPlaceholder}
          {...{ filePaths, onNeedFiles, fileReference, skillDiscovery, onNeedSkills }}
          stop={canStop ? { onStop, held: turnIndicator?.stopRequestInFlight === true } : null}
        />
      </View>
    </>
  )

  if (readFailedFinally && emptyStateView) {
    return <View style={rootStyle}>{emptyStateView}</View>
  }

  return (
    <MobileNativeChatOpenFileContext value={onOpenFile}>
      <MobileNativeChatComposerMenuHost testID="native-chat-view" style={rootStyle}>
        {status === 'loading' && messages.length === 0 ? (
          <MobileStateView
            loading
            title={t('session.nativeChatView.loading', 'Loading conversation…')}
          />
        ) : !hideTranscriptChrome && firstScreen ? (
          <MobileBotFirstScreen firstScreen={firstScreen} after={mailRows} />
        ) : (
          <GestureHandlerRootView style={styles.listWrap}>
            <MobileNativeChatDisclosureContext.Provider value={disclosures}>
              <MobileBotCardSendContext.Provider value={sendFromCard}>
                <MobileMarkdownBotCardContext.Provider value={drawReplyCard}>
                  <MobileNativeChatScrollRootsBoundary
                    {...{ rowKeys, layoutKey }}
                    roots={disclosures.roots}
                    runPlacements={rowKeys.runPlacements}
                  >
                    <MobileWorkerApprovalReceiptsContext value={workerReceipts}>
                      <MobileNativeChatRowList
                        {...{
                          tail,
                          rowKeys,
                          renderItem,
                          footer,
                          emptyStateView,
                          onScroll,
                          layoutKey
                        }}
                        {...{ header, hasHeader: hasMore === true, onNearTop: loadEarlierNearTop }}
                        itemJump={itemJump}
                        rows={turns.listMessages}
                        runs={turns.presentation.workRuns.heads}
                        roots={disclosures.roots}
                        contentContainerStyle={styles.listContent}
                        pinchGesture={pinchGesture}
                      />
                    </MobileWorkerApprovalReceiptsContext>
                  </MobileNativeChatScrollRootsBoundary>
                </MobileMarkdownBotCardContext.Provider>
              </MobileBotCardSendContext.Provider>
            </MobileNativeChatDisclosureContext.Provider>
            <MobileNativeChatFloatingControls
              showJumpToTail={tail.showJumpToTail}
              onJumpToTail={jumpToTail}
            />
          </GestureHandlerRootView>
        )}
        <MobileNativeChatLowerRegion scopeKey={sendSurfaceId} composerPresent={!promptOwnsInput}>
          {lowerContent}
        </MobileNativeChatLowerRegion>
      </MobileNativeChatComposerMenuHost>
    </MobileNativeChatOpenFileContext>
  )
}
