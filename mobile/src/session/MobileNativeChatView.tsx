import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { ArrowDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../src/shared/native-chat-turn-status'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
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
import { MobileNativeChatStopButton } from './MobileNativeChatStopButton'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { NO_COMPOSER_TRAY, type ComposerTrayProps } from './use-mobile-native-chat-composer-tray'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatScrollHold } from './MobileNativeChatScrollHold'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

type Props = ComposerTrayProps & {
  /** Raw transcript, only for telling "still loading" from "loaded and empty". */
  messages: NativeChatMessage[]
  /** `messages` with noise stripped and tool turns folded in, from the overlay. */
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  /** The read failed for good (damage, a newer Orca's chat): its error takes the whole pane. */
  readFailedFinally?: boolean
  /** Resolved agent for this chat; names the empty-state copy (desktop parity). */
  agent?: string | null
  agentWorking?: boolean
  canStop?: boolean
  /** Structured lane: per-turn "Working for N" status plus live tool progress,
   *  replacing the bridge lane's static three-dot working row (desktop parity). */
  structuredActivityUi?: boolean
  /** What labels the live turn's one indicator row (structured lane only). */
  turnIndicator?: NativeChatLiveTurnIndicator | null
  /** Structured lane: host-recorded turn timing feeding the per-turn status rows. */
  workingStartedAt?: number | null
  settledTurns?: NativeChatSettledTurns | null
  /** Structured lane: the journal that places each row in its turn. */
  turnJournal?: NativeChatTurnJournal | null
  /** Interrupt the agent mid-turn (shown as a Stop button on the working bar). */
  /** Interrupt a provider turn. */
  onStop?: () => void
  /** Live partial assistant text to show as an in-progress bubble, already gated
   *  by the overlay against the transcript catching up. */
  streaming: string | null
  hasMore?: boolean
  olderPages?: OlderPagePhase
  /** `settled`: on the page, an older page waits for it so it never lands under a moving reader. */
  onLoadEarlier?: (settled?: () => Promise<void>) => void
  onSend: (text: string) => Promise<boolean>
  /** Route identity used to fence accepted sends that settle after a tab/view switch. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation for accepted-send fencing. */
  getSendCompletionGeneration: () => number
  /** Reads user draft mutations from the route-owned controller. */
  getComposerEditGeneration: () => number
  /** Accepted user echoes awaiting transcript replacement, including image previews. */
  pending: MobileNativeChatPendingItem[]
  /** Local photo URIs retained when the authoritative transcript replaces an
   *  optimistic image bubble. */
  imagePreviewsByMessageId?: Record<string, string[]>
  /** Controlled composer text (owned by the route so dictation can write to it). */
  composerText: string
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  /** Pending image attachments shown as composer thumbnails until the next send. */
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  inputLockReason?: MobileNativeChatInputLockReason | null
  /** Route-reported send failure (answer cards, permission replies, stop). Shares the
   *  inline banner with a rejected composer send, so one failure paints once. The
   *  route routes these here only while this view is mounted, and falls back to its
   *  toast otherwise — a deferred failure must not land on an unmounted banner. */
  sendErrorMessage?: string | null
  /** Clears `sendErrorMessage` once a later send is accepted. */
  onClearSendError?: () => void
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** Model/session-option pickers for the composer action row (desktop parity). */
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  /** A pending agent question/permission detected from live status, shown as a
   *  native card above the composer; answering sends text to the agent. */
  /** Structured AskUserQuestion prompt parsed from the transcript (preferred over
   *  the heuristic question card). */
  ask?: AskPrompt | null
  /** Stable key for the ask card. Dismissal state lives in the controller (it
   *  must survive this subtree unmounting on a chat↔terminal toggle). */
  askKey?: string | null
  /** Hide the answered/dismissed ask until a different question arrives. */
  onDismissAsk?: () => void
  /** Deliver the ask answer as per-question selections; the send hook turns them
   *  into selector keystrokes (Claude) or pasted label text (other agents). */
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  onCancelAsk?: () => Promise<boolean>
  /** Cancel a structured approval/question with exact item identity when supported. */
  onCancelPrompt?: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
  permission?: MobileChatPermission | null
  promptKey?: string | null
  onRespondPermission?: (send: string) => Promise<boolean>
  /** Open a worktree file tapped in agent markdown. */
  onOpenFile?: (relativePath: string) => void
  /** Pixels to lift the composer by when the soft keyboard is open. The route
   *  owns keyboard tracking (the app uses manual lift, not KeyboardAvoidingView). */
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
}: Props): React.JSX.Element {
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
  const rowKeys = useMobileNativeChatRowKeys(folded, messages, sendSurfaceId)
  const tail = useMobileNativeChatTailFollow({ hasItems: data.length > 0, scopeKey: sendSurfaceId })
  const { jumpToTail, recordScrollMetrics, scrollMayLoadEarlier, pageSettled } = tail

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

  const loadEarlier = useCallback(() => onLoadEarlier?.(pageSettled), [onLoadEarlier, pageSettled])

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      recordScrollMetrics(e.nativeEvent)
      // Near the top — page in older history. Only the reader's drag: a pin reports offsets too.
      // After a failure only a tap retries, so a reader still at the top can't loop the spinner.
      if (contentOffset.y < 60 && hasMore && olderPages === 'idle' && scrollMayLoadEarlier()) {
        loadEarlier()
      }
    },
    [hasMore, olderPages, loadEarlier, scrollMayLoadEarlier, recordScrollMetrics]
  )

  // Per-turn status rows: one live indicator while the turn runs, then a settled
  // "Worked for N" row. The structured lane owns them; the bridge lane keeps its
  // three-dot indicator.
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
    lineYields: structuredActivityUi && (ask != null || permission != null || question != null),
    scopeKey: sendSurfaceId
  })

  const unsentNotices = useMemo(
    () => mobileNativeChatUnsentNotices(turnJournal, agent),
    [turnJournal, agent]
  )
  const renderItem = useCallback(
    ({ item, index }: { item: NativeChatMessage; index: number }) => (
      <MobileNativeChatMessage
        message={item}
        rowKey={rowKeys.keyOf(item)}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        onOpenFile={onOpenFile}
        structuredActivityUi={structuredActivityUi}
        onToggleTurn={turns.onToggleTurn}
        unsentNotice={item.unsent ? unsentNotices.get(item.id) : undefined}
        {...turns.resolveRow(index, item)}
      />
    ),
    [toolsExpanded, fontScale, onOpenFile, structuredActivityUi, turns, unsentNotices, rowKeys]
  )

  const liveStatus = turns.liveLine ? (
    <MobileNativeChatLiveLine
      line={turns.liveLine}
      onToggleReasoning={turns.onToggleReasoning}
      fontScale={fontScale}
      onOpenFile={onOpenFile}
    />
  ) : null

  const header = mobileNativeChatListHeader(hasMore, olderPages, loadEarlier)
  // How rows draw: a change re-lays every row, which the place-hold and the window both follow.
  const layoutKey = `${fontScale}:${toolsExpanded}`
  const pageHeader = (measuring: boolean) =>
    mobileNativeChatListHeader(hasMore, olderPages, loadEarlier, measuring)
  const footer = mobileNativeChatListFooter(liveStatus, turns.waitingRows, renderItem)
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
        <GestureHandlerRootView style={styles.listWrap}>
          <MobileNativeChatScrollHold {...{ rowKeys, layoutKey, ...tail.placeHold }} />
          <GestureDetector gesture={pinchGesture}>
            {Platform.OS === 'web' ? (
              <MobileNativeChatPageList
                {...tail.pageListProps}
                rows={turns.listMessages}
                rowKeys={rowKeys}
                renderItem={renderItem}
                rowState={turns.resolveRow}
                toolsExpanded={toolsExpanded}
                {...{ footer, emptyStateView, onScroll, header: pageHeader, layoutKey }}
              />
            ) : (
              <FlatList
                {...tail.listProps}
                data={turns.listMessages}
                keyExtractor={rowKeys.keyOf}
                renderItem={renderItem}
                contentContainerStyle={styles.listContent}
                // Let link/file taps land while the composer keyboard is up
                // instead of being swallowed by the dismiss gesture.
                keyboardShouldPersistTaps="handled"
                onScroll={onScroll}
                onScrollBeginDrag={tail.beginUserScroll}
                onScrollEndDrag={tail.endUserDrag}
                onMomentumScrollBegin={tail.beginMomentum}
                onMomentumScrollEnd={tail.endMomentum}
                scrollEventThrottle={32}
                onContentSizeChange={tail.pinToTailAfterContentResize}
                onLayout={tail.pinToTail}
                maintainVisibleContentPosition={mobileNativeChatRowAnchor(hasMore === true)}
                ListHeaderComponent={header}
                ListFooterComponent={footer}
                ListEmptyComponent={emptyStateView}
              />
            )}
          </GestureDetector>
          {tail.showJumpToTail ? (
            <Pressable
              accessibilityLabel="Scroll to latest"
              style={[styles.fab, styles.fabBottom]}
              onPress={jumpToTail}
            >
              <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </GestureHandlerRootView>
      )}
      {trayContent}
      <MobileNativeChatPromptCard
        key={promptKey ?? undefined}
        {...{ ask, askKey, onDismissAsk, onAnswerAsk, onCancelAsk, onCancelPrompt, onCollapseAsk }}
        {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
        collapsedPrompt={collapsedPrompt}
      />
      <View style={styles.chromeRow}>
        <View style={styles.chromeLeft}>
          {agentWorking && !structuredActivityUi ? <MobileAgentWorkingIndicator /> : null}
          <Pressable
            style={({ pressed }) => [styles.chromeToggle, pressed && styles.pressed]}
            onPress={() => setToolsExpanded((v) => !v)}
            hitSlop={8}
          >
            {toolsExpanded ? (
              <ChevronsDownUp size={14} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2} />
            )}
            <Text style={styles.chromeToggleLabel}>{toolsExpanded ? 'Collapse' : 'Tools'}</Text>
          </Pressable>
        </View>
        {canStop ? (
          // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
          <MobileNativeChatStopButton
            onStop={onStop}
            held={agentWorking === true && turnIndicator?.stopRequestInFlight === true}
          />
        ) : null}
      </View>
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
      />
    </View>
  )
}
