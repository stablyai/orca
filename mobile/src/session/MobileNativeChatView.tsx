import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { ArrowDown } from 'lucide-react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState,
  type MobileNativeChatPendingItem
} from './mobile-native-chat-render-data'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import { MobileNativeChatTurnStatus } from './MobileNativeChatTurnStatus'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { MobileNativeChatChromeRow } from './MobileNativeChatChromeRow'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

const INPUT_LOCK_SETTLE_MS = 600

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

type Props = {
  /** Raw transcript, only for telling "still loading" from "loaded and empty". */
  messages: NativeChatMessage[]
  /** `messages` with noise stripped and tool turns folded in, from the overlay. */
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  /** Resolved agent for this chat; names the empty-state copy (desktop parity). */
  agent?: string | null
  agentWorking?: boolean
  /** Structured lane: per-turn "Working for N" status plus live tool progress,
   *  replacing the bridge lane's static three-dot working row (desktop parity). */
  structuredActivityUi?: boolean
  /** Interrupt the agent mid-turn (shown as a Stop button on the working bar). */
  onStop?: () => void
  /** Live partial assistant text to show as an in-progress bubble, already gated
   *  by the overlay against the transcript catching up. */
  streaming: string | null
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
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
  dictationMode?: 'toggle' | 'hold'
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
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => Promise<boolean>
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  /** Open a worktree file tapped in agent markdown. */
  onOpenFile?: (relativePath: string) => void
  onOpenLink?: (url: string) => void
  onCopyText?: (text: string) => Promise<unknown>
  /** Pixels to lift the composer by when the soft keyboard is open. The route
   *  owns keyboard tracking (the app uses manual lift, not KeyboardAvoidingView). */
  keyboardInset?: number
}

export function MobileNativeChatView({
  messages,
  folded,
  status,
  error,
  agent,
  agentWorking,
  structuredActivityUi = false,
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
  question,
  onAnswerQuestion,
  permission,
  onRespondPermission,
  onOpenFile,
  onOpenLink,
  onCopyText,
  keyboardInset = 0
}: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const listRef = useRef<FlatList<NativeChatMessage>>(null)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const [atBottom, setAtBottom] = useState(true)
  const sendScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()
  useEffect(
    () => () => {
      if (sendScrollTimerRef.current) {
        clearTimeout(sendScrollTimerRef.current)
      }
    },
    []
  )

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

  useEffect(() => {
    if (data.length === 0 || !atBottom) {
      return
    }
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60)
    return () => clearTimeout(t)
  }, [data.length, atBottom, keyboardInset])

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
      setAtBottom(true)
      if (sendScrollTimerRef.current) {
        clearTimeout(sendScrollTimerRef.current)
      }
      sendScrollTimerRef.current = setTimeout(() => {
        sendScrollTimerRef.current = null
        listRef.current?.scrollToEnd({ animated: true })
      }, 60)
      return true
    },
    [onSend, onClearSendError]
  )

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height)
      setAtBottom(distanceFromBottom < 80)
      // Near the top — page in older history.
      if (contentOffset.y < 60 && hasMore && !loadingEarlier) {
        onLoadEarlier?.()
      }
    },
    [hasMore, loadingEarlier, onLoadEarlier]
  )

  const toggleTools = useCallback(() => setToolsExpanded((v) => !v), [])

  // Align a single message's top to the top of the viewport.
  const onScrollToMessage = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
  }, [])

  // Per-turn "Thinking / Working for N / Worked for N" rows. The structured lane
  // owns them; the bridge lane keeps its three-dot indicator.
  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: structuredActivityUi,
    isWorking: agentWorking === true,
    scopeKey: sendSurfaceId
  })

  const renderItem = useCallback(
    ({ item, index }: { item: NativeChatMessage; index: number }) => (
      <MobileNativeChatMessage
        message={item}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        messageIndex={index}
        onScrollToMessage={onScrollToMessage}
        onOpenFile={onOpenFile}
        onOpenLink={onOpenLink}
        onCopyText={onCopyText}
        structuredActivityUi={structuredActivityUi}
        onToggleTurn={turns.onToggleTurn}
        {...turns.resolveRow(index, item)}
      />
    ),
    [
      toolsExpanded,
      fontScale,
      onScrollToMessage,
      onOpenFile,
      onOpenLink,
      onCopyText,
      structuredActivityUi,
      turns
    ]
  )

  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)
  const showLoading = status === 'loading' && messages.length === 0

  // A dead PTY emits subscribed→end; settle both edges so its false lease cannot flash the composer enabled.
  const rawLockReason = inputLockReason ?? null
  const rawLockHeld = rawLockReason !== null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawLockHeld === lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(rawLockHeld), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawLockHeld])
  const lockReason = lockHeld ? (rawLockReason ?? 'waiting') : null

  return (
    <View style={[styles.root, { paddingBottom: bottomPad }]}>
      {showLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <GestureHandlerRootView style={styles.listWrap}>
          <GestureDetector gesture={pinchGesture}>
            <FlatList
              ref={listRef}
              data={data}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={styles.listContent}
              // Let link/file taps land while the composer keyboard is up
              // instead of being swallowed by the dismiss gesture.
              keyboardShouldPersistTaps="handled"
              onScroll={onScroll}
              scrollEventThrottle={32}
              onContentSizeChange={() => {
                if (data.length > 0 && atBottom) {
                  listRef.current?.scrollToEnd({ animated: false })
                }
              }}
              // scrollToIndex can fail before an off-screen row is measured —
              // fall back to an estimated offset, then retry once it's laid out.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: true
                })
                setTimeout(() => {
                  listRef.current?.scrollToIndex({
                    index: info.index,
                    viewPosition: 0,
                    animated: true
                  })
                }, 120)
              }}
              ListHeaderComponent={
                hasMore ? (
                  <Pressable
                    style={styles.loadEarlier}
                    onPress={onLoadEarlier}
                    disabled={loadingEarlier}
                  >
                    {loadingEarlier ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Text style={styles.loadEarlierText}>Load earlier messages</Text>
                    )}
                  </Pressable>
                ) : null
              }
              ListFooterComponent={
                turns.activeTurnIsUnanchored && turns.active ? (
                  <MobileNativeChatTurnStatus
                    startedAt={turns.active.startedAt}
                    thinking={turns.active.thinking}
                    workedSeconds={turns.active.workedSeconds}
                  />
                ) : null
              }
              ListEmptyComponent={
                emptyState ? (
                  <View style={styles.center}>
                    <Text style={styles.emptyTitle}>{emptyState.title}</Text>
                    <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
                  </View>
                ) : null
              }
            />
          </GestureDetector>
          {!atBottom ? (
            <Pressable
              accessibilityLabel="Scroll to latest"
              style={[styles.fab, styles.fabBottom]}
              onPress={() => listRef.current?.scrollToEnd({ animated: true })}
            >
              <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </GestureHandlerRootView>
      )}
      <MobileNativeChatPromptCard
        ask={ask}
        askKey={askKey}
        onDismissAsk={onDismissAsk}
        onAnswerAsk={onAnswerAsk}
        onCancelAsk={onCancelAsk}
        permission={permission}
        onRespondPermission={onRespondPermission}
        question={question}
        onAnswerQuestion={onAnswerQuestion}
      />
      <MobileNativeChatChromeRow
        agentWorking={agentWorking}
        structuredActivityUi={structuredActivityUi}
        toolsExpanded={toolsExpanded}
        onToggleTools={toggleTools}
        onStop={onStop}
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
        value={composerText}
        onChangeText={onComposerTextChange}
        onSend={handleSend}
        sendSurfaceId={sendSurfaceId}
        {...{ getSendCompletionGeneration, getComposerEditGeneration }}
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
        placeholder={
          lockReason === 'disconnected'
            ? 'Reconnecting…'
            : lockReason === 'waiting'
              ? 'Waiting for terminal…'
              : 'Message, @files, /commands'
        }
        filePaths={filePaths}
        onNeedFiles={onNeedFiles}
      />
    </View>
  )
}
