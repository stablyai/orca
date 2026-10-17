import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import { mobileNativeChatListFooter } from './mobile-native-chat-list-footer'
import { mobileNativeChatListHeader } from './mobile-native-chat-list-header'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState
} from './mobile-native-chat-render-data'
import { useMobileNativeChatPageHistory } from './use-mobile-native-chat-page-history'
import { useMobileNativeChatInitialLayout } from './use-mobile-native-chat-initial-layout'
import {
  MobileTranscriptLayoutContext,
  useMobileTranscriptLayout
} from '../components/mobile-transcript-layout'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import {
  mobileNativeChatRowAnchor,
  useMobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import {
  mobileNativeChatComposerPlaceholder,
  useSettledMobileNativeChatInputLock
} from './use-mobile-native-chat-input-lease'
import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'
import { MobileNativeChatFloatingControls } from './MobileNativeChatFloatingControls'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { mobileNativeChatToolCallCount } from './mobile-native-chat-composer-layout'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { NO_COMPOSER_TRAY } from './use-mobile-native-chat-composer-tray'
import { MobileNativeChatScrollHold } from './MobileNativeChatScrollHold'
import { useMobileNativeChatRowRenderer } from './use-mobile-native-chat-row-renderer'

export type { MobileNativeChatInputLockReason } from './mobile-native-chat-view-props'
import type { MobileNativeChatViewProps } from './mobile-native-chat-view-props'

export function MobileNativeChatView({
  messages,
  folded,
  status,
  error,
  readFailedFinally = false,
  agent,
  agentWorking,
  canStop = agentWorking,
  structuredActivityUi = false,
  turnIndicator = null,
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  receipts = null,
  actionablePromptIds,
  onStop,
  streaming,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  pending,
  imagePreviewsByMessageId,
  composerText,
  onComposerTextChange,
  onAttachImage,
  attachments,
  onRemoveAttachment,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  filePaths,
  onNeedFiles,
  sessionOptions,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
  question,
  onAnswerQuestion,
  permission,
  promptKey,
  onRespondPermission,
  composerTray: { content: trayContent, composerInputRef: inputRef } = NO_COMPOSER_TRAY,
  onOpenFile,
  keyboardInset = 0
}: MobileNativeChatViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [toolsExpanded, setToolsExpanded] = useState(false)
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  // `data` is the list source: folded transcript + synthetic streaming bubble +
  // route-owned accepted echoes. Memoize on the same deps so the
  // downstream autoscroll effects/`renderItem` keep referential stability.
  const { data } = useMemo(
    () =>
      buildMobileNativeChatTransientData({
        messages,
        folded,
        streaming,
        pending,
        imagePreviewsByMessageId
      }),
    [messages, folded, streaming, pending, imagePreviewsByMessageId]
  )
  const {
    listRef,
    showJumpToTail,
    pinToTail,
    pinToTailAfterContentResize,
    jumpToTail,
    beginUserScroll,
    endUserDrag,
    beginMomentum,
    endMomentum,
    readerIsScrolling,
    recordScrollMetrics
  } = useMobileNativeChatTailFollow({ items: data, scopeKey: sendSurfaceId })
  const transcriptLayout = useMobileTranscriptLayout()
  const initialLayout = useMobileNativeChatInitialLayout(
    sendSurfaceId,
    data.length > 0,
    transcriptLayout.pending
  )

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const accepted = await onSend(text)
      if (!accepted) {
        return false
      }
      // The route-owned banner outlives this send; a success must retire it too,
      // or a stale "Message not sent" sits above the delivered message.
      onClearSendError?.()
      // Always jump to the newest message when the user sends.
      jumpToTail()
      return true
    },
    [onSend, onClearSendError, jumpToTail]
  )

  const loadEarlier = useCallback(() => onLoadEarlier?.(), [onLoadEarlier])

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      recordScrollMetrics(e.nativeEvent)
      // Near the top — page in older history. Only the reader's scroll: a pin reports offsets too.
      if (contentOffset.y < 60 && hasMore && !loadingEarlier && readerIsScrolling()) {
        loadEarlier()
      }
    },
    [hasMore, loadingEarlier, loadEarlier, readerIsScrolling, recordScrollMetrics]
  )

  // Per-turn status rows: one live indicator while the turn runs, then a settled
  // "Worked for N" row. The structured lane owns them; the bridge lane gets the live line only.
  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: structuredActivityUi,
    isWorking: agentWorking === true,
    workingStartedAt,
    settledTurns,
    turnJournal,
    thinking: turnIndicator?.thinking === true,
    activityText: turnIndicator?.activityText ?? null,
    // The display status, decided once in the session hook.
    stopping: turnIndicator?.stopping === true,
    lineYields: ask != null || permission != null || question != null,
    scopeKey: sendSurfaceId,
    processExpanded: toolsExpanded,
    actionablePromptIds
  })

  const renderItem = useMobileNativeChatRowRenderer({
    toolsExpanded,
    fontScale,
    onOpenFile,
    structuredActivityUi,
    turns,
    turnJournal,
    agent,
    receipts,
    actionablePromptIds
  })

  const history = useMobileNativeChatPageHistory(turns.listMessages, renderItem, sendSurfaceId)
  const [initialWindow, setInitialWindow] = useState({
    scope: sendSurfaceId,
    rows: history.listRows.length
  })
  if (
    initialWindow.scope !== sendSurfaceId ||
    (initialWindow.rows === 0 && history.listRows.length > 0)
  ) {
    setInitialWindow({ scope: sendSurfaceId, rows: history.listRows.length })
  }

  const liveStatus = turns.liveLine ? (
    <MobileNativeChatLiveLine
      line={turns.liveLine}
      onToggleReasoning={turns.onToggleReasoning}
      fontScale={fontScale}
      onOpenFile={onOpenFile}
    />
  ) : null
  const toolCallCount = useMemo(() => mobileNativeChatToolCallCount(folded), [folded])
  const toggleTools = useCallback(() => setToolsExpanded((v) => !v), [])

  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)

  const lockReason = useSettledMobileNativeChatInputLock(inputLockReason)
  // Why only Send, terminal-backed only: that send types into the agent's prompt and can answer it,
  // while drafting never does; the host queues a structured send behind it.
  const expandedPromptOwnsSend =
    !structuredActivityUi && !collapsedPrompt && (ask ?? permission ?? question) != null
  const emptyStateView = emptyState ? (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{emptyState.title}</Text>
      <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
    </View>
  ) : null

  // Whatever was already on screen: nothing here can act on a chat that cannot load, and its words
  // say why once, as a fresh open's do.
  if (readFailedFinally && emptyStateView) {
    return <View style={[styles.root, { paddingBottom: bottomPad }]}>{emptyStateView}</View>
  }

  return (
    <View style={[styles.root, { paddingBottom: bottomPad }]}>
      {status === 'loading' && messages.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <MobileTranscriptLayoutContext.Provider value={transcriptLayout.register}>
          <GestureHandlerRootView style={styles.listWrap}>
            <MobileNativeChatScrollHold headKey={turns.listMessages[0]?.id} listRef={listRef} />
            <GestureDetector gesture={pinchGesture}>
              <FlatList
                key={sendSurfaceId}
                style={initialLayout.ready ? undefined : { opacity: 0 }}
                pointerEvents={initialLayout.ready ? 'auto' : 'none'}
                ref={listRef}
                data={history.listRows}
                initialScrollIndex={Math.max(0, initialWindow.rows - 10)}
                initialNumToRender={10}
                onScrollToIndexFailed={pinToTail}
                keyExtractor={(item) => item.id}
                renderItem={history.renderListRow}
                contentContainerStyle={
                  toolCallCount > 0 ? styles.listContentUnderFloatingControls : styles.listContent
                }
                // Let link/file taps land while the composer keyboard is up
                // instead of being swallowed by the dismiss gesture.
                keyboardShouldPersistTaps="handled"
                onScroll={onScroll}
                onScrollBeginDrag={beginUserScroll}
                onScrollEndDrag={endUserDrag}
                onMomentumScrollBegin={beginMomentum}
                onMomentumScrollEnd={endMomentum}
                scrollEventThrottle={32}
                onContentSizeChange={(width, height) => {
                  pinToTailAfterContentResize(width, height)
                  initialLayout.recordContent(height)
                }}
                onLayout={(event) => {
                  pinToTail()
                  initialLayout.recordLayout(event)
                }}
                updateCellsBatchingPeriod={initialLayout.ready ? 50 : 0}
                maintainVisibleContentPosition={mobileNativeChatRowAnchor(hasMore === true)}
                ListHeaderComponent={history.withHistory(
                  mobileNativeChatListHeader(hasMore, loadingEarlier, loadEarlier)
                )}
                ListFooterComponent={mobileNativeChatListFooter(
                  liveStatus,
                  turns.waitingRows,
                  renderItem
                )}
                ListEmptyComponent={emptyStateView}
              />
            </GestureDetector>
            {!initialLayout.ready ? (
              <View style={[styles.center, StyleSheet.absoluteFill]} pointerEvents="none">
                <ActivityIndicator
                  accessibilityLabel="Loading conversation"
                  color={colors.textSecondary}
                />
              </View>
            ) : null}
            <MobileNativeChatFloatingControls
              toolCallCount={toolCallCount}
              toolsExpanded={toolsExpanded}
              onToggleTools={toggleTools}
              showJumpToTail={showJumpToTail}
              onJumpToTail={jumpToTail}
            />
          </GestureHandlerRootView>
        </MobileTranscriptLayoutContext.Provider>
      )}
      {trayContent}
      <MobileNativeChatPromptCard
        key={promptKey ?? undefined}
        {...{ ask, askKey, onDismissAsk, onAnswerAsk, onCancelAsk, onCancelPrompt, onCollapseAsk }}
        {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
        collapsedPrompt={collapsedPrompt}
      />
      {sendErrorMessage ? (
        // This banner is the only channel for a send failure — announce it.
        <View
          style={styles.sendError}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Text style={styles.sendErrorText}>{sendErrorMessage}</Text>
        </View>
      ) : null}
      <MobileNativeChatComposer
        structuredCommands={
          structuredActivityUi ? (sessionOptions?.controller.conversationCommands ?? []) : undefined
        }
        value={composerText}
        onChangeText={onComposerTextChange}
        onSend={handleSend}
        sendSurfaceId={sendSurfaceId}
        {...{ getSendCompletionGeneration, getComposerEditGeneration, inputRef }}
        agent={agent}
        sessionOptions={sessionOptions}
        onAttachImage={onAttachImage}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        isAttaching={isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        dictationMode={dictationMode}
        onMicPressIn={onMicPressIn}
        onMicPressOut={onMicPressOut}
        disabled={lockReason !== null}
        sendDisabled={expandedPromptOwnsSend}
        placeholder={mobileNativeChatComposerPlaceholder(lockReason, turnIndicator?.afterStop)}
        filePaths={filePaths}
        onNeedFiles={onNeedFiles}
        stop={
          canStop
            ? {
                onStop,
                held: agentWorking === true && turnIndicator?.stopRequestInFlight === true
              }
            : null
        }
      />
    </View>
  )
}
