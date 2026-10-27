import { useCallback, useMemo } from 'react'
import { nativeChatTaskListPredecessors } from '../../../src/shared/native-chat-task-list-history'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './mobile-native-chat-disclosure-store'
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import type { AskAnswerSelection } from '../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../src/shared/native-chat-ask-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../src/shared/native-chat-turn-status'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import { mobileNativeChatListFooter } from './mobile-native-chat-list-footer'
import { mobileNativeChatListHeader } from './mobile-native-chat-list-header'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState,
  type MobileNativeChatPendingItem
} from './mobile-native-chat-render-data'
import { useMobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { useMobileNativeChatTailFollow } from './use-mobile-native-chat-tail-follow'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import {
  mobileNativeChatComposerPlaceholder,
  useSettledMobileNativeChatInputLock
} from './native-chat/use-mobile-native-chat-input-lease'
import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'
import { MobileNativeChatFloatingControls } from './MobileNativeChatFloatingControls'
import type { PendingNativeChatImage } from './native-chat/composer/mobile-native-chat-image-attachment'
import {
  MobileNativeChatComposer,
  type MobileNativeChatStructuredComposer
} from './native-chat/composer/MobileNativeChatComposer'
import { MobileNativeChatPromptCard } from './native-chat/input/MobileNativeChatPromptCard'
import {
  NO_COMPOSER_TRAY,
  type ComposerTrayProps
} from './native-chat/composer/use-mobile-native-chat-composer-tray'
import type { MobileChatPermission } from './native-chat/input/mobile-native-chat-permission'
import type { MobileChatQuestion } from './native-chat/input/mobile-native-chat-question'
import type { MobileNativeChatSessionOptionPickersProps } from './native-chat/input/MobileNativeChatSessionOptionPickers'
import { MobileNativeChatScrollRootsBoundary } from './MobileNativeChatScrollRootsBoundary'
import { MobileNativeChatRowList } from './MobileNativeChatRowList'
import { useMobileNativeChatRowRenderer } from './use-mobile-native-chat-row-renderer'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

type Props = ComposerTrayProps & {
  // Keep raw messages to distinguish loading from a loaded transcript filtered to empty.
  messages: NativeChatMessage[]
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  // Permanent read failure replaces the pane because further chat actions cannot succeed.
  readFailedFinally?: boolean
  agent?: string | null
  agentWorking?: boolean
  canStop?: boolean
  structuredActivityUi?: boolean
  turnIndicator?: NativeChatLiveTurnIndicator | null
  workingStartedAt?: number | null
  settledTurns?: NativeChatSettledTurns | null
  turnJournal?: NativeChatTurnJournal | null
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds?: readonly string[]
  onStop?: () => void
  // The overlay already gates partial text against authoritative transcript replacement.
  streaming: string | null
  hasMore?: boolean
  olderPages?: OlderPagePhase
  onLoadEarlier?: () => void
  onSend: (text: string) => Promise<boolean>
  // Fence send completion by route identity after tab/view switches.
  sendSurfaceId: string
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  pending: MobileNativeChatPendingItem[]
  // Retain local preview URIs after authoritative image messages replace optimistic rows.
  imagePreviewsByMessageId?: Record<string, string[]>
  composerText: string
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  inputLockReason?: MobileNativeChatInputLockReason | null
  // Report send failures here only while mounted; the route uses a toast otherwise.
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  structuredComposer?: MobileNativeChatStructuredComposer | null
  ask?: AskPrompt | null
  // Keep dismissal identity above chat/terminal toggles.
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  askRequiresTerminal?: boolean
  onAnswerInTerminal?: () => void
  onCancelAsk?: () => Promise<boolean>
  onCancelPrompt?: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
  permission?: MobileChatPermission | null
  promptKey?: string | null
  onRespondPermission?: (send: string) => Promise<boolean>
  onOpenFile?: (relativePath: string) => void
  keyboardInset?: number
}

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
  olderPages = 'idle',
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
  structuredComposer = null,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
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
  promptKey,
  onRespondPermission,
  composerTray: { content: trayContent, composerInputRef: inputRef } = NO_COMPOSER_TRAY,
  onOpenFile,
  keyboardInset = 0
}: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  // Memoize list derivation to keep downstream autoscroll/renderItem dependencies stable.
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
  const tail = useMobileNativeChatTailFollow({ hasItems: data.length > 0, scopeKey: sendSurfaceId })
  const { jumpToTail, recordScrollMetrics, scrollMayLoadEarlier } = tail

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const accepted = await onSend(text)
      if (!accepted) {
        return false
      }
      // Retire the route-owned banner too or an accepted send keeps the old failure visible.
      onClearSendError?.()
      jumpToTail()
      return true
    },
    [onSend, onClearSendError, jumpToTail]
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

  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: structuredActivityUi,
    isWorking: agentWorking === true,
    workingStartedAt,
    settledTurns,
    turnJournal,
    thinking: turnIndicator?.thinking === true,
    activityText: turnIndicator?.activityText ?? null,
    stopping: turnIndicator?.stopping === true,
    lineYields: ask != null || permission != null || question != null,
    receipts,
    scopeKey: sendSurfaceId
  })

  const rowKeys = useMobileNativeChatRowKeys(folded, messages, sendSurfaceId, turns.presentation)
  const disclosures = useMobileNativeChatDisclosures(sendSurfaceId)
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(data), [data])
  const renderItem = useMobileNativeChatRowRenderer({
    scope: sendSurfaceId,
    rowKeyOf: rowKeys.keyOf,
    runOwners: rowKeys.runOwners,
    taskListPredecessors,
    fontScale,
    onOpenFile,
    structuredActivityUi,
    turns,
    turnJournal,
    agent,
    receipts,
    actionablePromptIds
  })

  const liveStatus = turns.liveLine ? (
    <MobileNativeChatLiveLine
      line={turns.liveLine}
      onToggleReasoning={turns.onToggleReasoning}
      fontScale={fontScale}
      onOpenFile={onOpenFile}
    />
  ) : null

  const header = mobileNativeChatListHeader(hasMore, olderPages, loadEarlier)
  // Changing text scale relays out every row, so preserve the page’s reading anchor.
  const layoutKey = `${fontScale}`
  const footer = mobileNativeChatListFooter(liveStatus, turns.waitingRows, renderItem)
  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)

  const lockReason = useSettledMobileNativeChatInputLock(inputLockReason)
  const composerPlaceholder = mobileNativeChatComposerPlaceholder(
    lockReason,
    turnIndicator?.afterStop
  )
  // Lock only terminal-backed Send: it can answer an agent prompt, while drafting is harmless and structured sends queue.
  const expandedPromptOwnsSend =
    !structuredActivityUi && !collapsedPrompt && (ask ?? permission ?? question) != null
  const emptyStateView = emptyState ? (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{emptyState.title}</Text>
      <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
    </View>
  ) : null

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
        <GestureHandlerRootView style={styles.listWrap}>
          <MobileNativeChatDisclosureContext.Provider value={disclosures}>
            <MobileNativeChatScrollRootsBoundary
              {...{ rowKeys, layoutKey }}
              roots={disclosures.roots}
              runPlacements={rowKeys.runPlacements}
            >
              <GestureDetector gesture={pinchGesture}>
                <MobileNativeChatRowList
                  {...{ tail, rowKeys, renderItem, footer, emptyStateView, onScroll, layoutKey }}
                  {...{ header, hasHeader: hasMore === true, onNearTop: loadEarlierNearTop }}
                  rows={turns.listMessages}
                  runs={turns.presentation.workRuns.heads}
                  roots={disclosures.roots}
                  contentContainerStyle={styles.listContent}
                />
              </GestureDetector>
            </MobileNativeChatScrollRootsBoundary>
          </MobileNativeChatDisclosureContext.Provider>
          <MobileNativeChatFloatingControls
            showJumpToTail={tail.showJumpToTail}
            onJumpToTail={jumpToTail}
          />
        </GestureHandlerRootView>
      )}
      <MobileNativeChatPromptCard
        key={promptKey ?? undefined}
        {...{ ask, askKey, onDismissAsk, onAnswerAsk, onCancelAsk, onCancelPrompt, onCollapseAsk }}
        requiresTerminal={askRequiresTerminal}
        onAnswerInTerminal={onAnswerInTerminal}
        {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
        collapsedPrompt={collapsedPrompt}
      />
      <Text
        style={lockReason === 'waiting' ? styles.inputLockStatus : undefined}
        accessibilityLiveRegion="polite"
      >
        {lockReason === 'waiting' ? composerPlaceholder : null}
      </Text>
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
      {}
      {trayContent}
      <MobileNativeChatComposer
        structured={structuredActivityUi ? structuredComposer : null}
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
        placeholder={composerPlaceholder}
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
