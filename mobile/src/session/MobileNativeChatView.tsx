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
import { ArrowDown, ChevronsDownUp, ChevronsUpDown, Square } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages,
  mobileNativeChatEmptyState,
  type MobileNativeChatPendingItem
} from './mobile-native-chat-render-data'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { AskAnswerSelection, AskPrompt } from './mobile-native-chat-ask'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { mobileChatQuestionKey, type MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

type Props = {
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  /** Resolved agent for this chat; names the empty-state copy (desktop parity). */
  agent?: string | null
  agentWorking?: boolean
  /** Interrupt the agent mid-turn (shown as a Stop button on the working bar). */
  onStop?: () => void
  /** Live partial assistant text while a turn is still streaming (from the agent
   *  status hook). Shown as an in-progress bubble until the transcript catches up. */
  streamingText?: string
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
  onSend: (text: string) => Promise<boolean>
  /** Optimistic queued sends (owned by the route so they survive view switches). */
  /** Optimistic user echoes, including any ridden-along image preview URIs. */
  pending: MobileNativeChatPendingItem[]
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
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** A pending agent question/permission detected from live status, shown as a
   *  native card above the composer; answering sends text to the agent. */
  /** Structured AskUserQuestion prompt parsed from the transcript (preferred over
   *  the heuristic question card). */
  ask?: AskPrompt | null
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
  /** Pixels to lift the composer by when the soft keyboard is open. The route
   *  owns keyboard tracking (the app uses manual lift, not KeyboardAvoidingView). */
  keyboardInset?: number
}

export function MobileNativeChatView({
  messages,
  status,
  error,
  agent,
  agentWorking,
  onStop,
  streamingText,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  onSend,
  pending,
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
  filePaths,
  onNeedFiles,
  ask,
  onAnswerAsk,
  onCancelAsk,
  question,
  onAnswerQuestion,
  permission,
  onRespondPermission,
  onOpenFile,
  keyboardInset = 0
}: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const listRef = useRef<FlatList<NativeChatMessage>>(null)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  // Dismiss the question card as soon as it's answered; the live status lingers
  // briefly (the agent emits a post-tool event with the same prompt), so hide it
  // until a genuinely different question arrives.
  const { askKey, showAsk, dismissAsk } = useMobileNativeChatAskDismiss(ask)
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const [atBottom, setAtBottom] = useState(true)
  const sendScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()
  // Surface a rejected send inline above the composer — a bottom toast gets hidden
  // behind the keyboard (the case that prompted this). Auto-dismisses after a beat.
  const [sendFailed, setSendFailed] = useState(false)
  useEffect(() => {
    if (!sendFailed) {
      return
    }
    const t = setTimeout(() => setSendFailed(false), 4000)
    return () => clearTimeout(t)
  }, [sendFailed])

  useEffect(
    () => () => {
      if (sendScrollTimerRef.current) {
        clearTimeout(sendScrollTimerRef.current)
      }
    },
    []
  )

  const pendingIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending])
  // `data` is the list source: folded transcript + synthetic streaming bubble +
  // route-owned optimistic queued messages. Memoize on the same deps so the
  // downstream autoscroll effects/`renderItem` keep referential stability.
  const foldedMessages = useMemo(() => foldMobileNativeChatMessages(messages), [messages])
  const { data } = useMemo(
    () => buildMobileNativeChatTransientData({ folded: foldedMessages, streamingText, pending }),
    [foldedMessages, streamingText, pending]
  )

  // Follow the tail as the conversation grows and keep the newest message above
  // the keyboard when it opens — but only when already pinned to the bottom, so
  // we don't yank the user away while they read history. (Also fires on keyboard
  // close, which is harmless while atBottom.)
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
        setSendFailed(true)
        return false
      }
      setSendFailed(false)
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
    [onSend]
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

  // Align a single message's top to the top of the viewport.
  const onScrollToMessage = useCallback((index: number) => {
    listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
  }, [])

  const renderItem = useCallback(
    ({ item, index }: { item: NativeChatMessage; index: number }) => (
      <MobileNativeChatMessage
        message={item}
        queued={pendingIds.has(item.id)}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        messageIndex={index}
        onScrollToMessage={onScrollToMessage}
        onOpenFile={onOpenFile}
      />
    ),
    [pendingIds, toolsExpanded, fontScale, onScrollToMessage, onOpenFile]
  )

  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)
  const showLoading = status === 'loading' && messages.length === 0

  // Composer-lock flicker guard: on a remote link, brief connState blips or lease
  // hand-offs would otherwise toggle the lock placeholder on and off. Only surface
  // a lock once it has held ~600ms; drop it instantly so unlocking stays snappy.
  const rawLockReason = inputLockReason ?? null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawLockReason === null) {
      setLockHeld(false)
      return
    }
    const timer = setTimeout(() => setLockHeld(true), 600)
    return () => clearTimeout(timer)
  }, [rawLockReason])
  const lockReason = lockHeld ? rawLockReason : null

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
          {/* Jump-to-latest control. The scroll-to-top affordance now lives
              per-message (the up-arrow in each agent message's controls). */}
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
      {/* Pending agent prompt: a structured AskUserQuestion wins, then a
          heuristic permission, then a heuristic question. */}
      {showAsk && ask ? (
        <MobileNativeChatAsk
          key={askKey ?? 'ask'}
          prompt={ask}
          onAnswer={async (selections) => {
            const accepted = (await onAnswerAsk?.(ask, selections)) ?? false
            if (accepted) {
              dismissAsk()
            }
            return accepted
          }}
          onCancel={async () => {
            const accepted = (await onCancelAsk?.()) ?? false
            if (accepted) {
              dismissAsk()
            }
            return accepted
          }}
        />
      ) : permission ? (
        <MobileNativeChatPermission
          key={JSON.stringify(permission)}
          permission={permission}
          onRespond={async (send) => (await onRespondPermission?.(send)) ?? false}
        />
      ) : question ? (
        <MobileNativeChatQuestion
          key={mobileChatQuestionKey(question)}
          question={question}
          onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
        />
      ) : null}
      {/* Chrome row above the composer: the working indicator and the global
          tool-calls expand/collapse toggle on the left, Stop in the far corner. */}
      <View style={styles.chromeRow}>
        <View style={styles.chromeLeft}>
          {agentWorking ? <MobileAgentWorkingIndicator /> : null}
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
        {agentWorking ? (
          <Pressable
            style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
            onPress={onStop}
            hitSlop={8}
            accessibilityLabel="Stop the agent"
          >
            <Square size={13} color={colors.statusRed} strokeWidth={2.4} fill={colors.statusRed} />
            <Text style={styles.stopLabel}>Stop</Text>
          </Pressable>
        ) : null}
      </View>
      {sendFailed ? (
        <View style={styles.sendError}>
          <Text style={styles.sendErrorText}>
            {rawLockReason === 'disconnected'
              ? 'Message not sent — reconnecting…'
              : 'Message not sent'}
          </Text>
        </View>
      ) : null}
      <MobileNativeChatComposer
        value={composerText}
        onChangeText={onComposerTextChange}
        onSend={handleSend}
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
