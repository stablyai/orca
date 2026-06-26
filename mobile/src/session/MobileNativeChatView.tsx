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
import type { DiscoveredSkill } from '../../../src/shared/skills'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import { buildMobileNativeChatData, statusHint } from './mobile-native-chat-render-data'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { AskPrompt } from './mobile-native-chat-ask'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

type Props = {
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  agentWorking?: boolean
  /** Interrupt the agent mid-turn (shown as a Stop button on the working bar). */
  onStop?: () => void
  /** Live partial assistant text while a turn is still streaming (from the agent
   *  status hook). Shown as an in-progress bubble until the transcript catches up. */
  streamingText?: string
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
  onSend: (text: string) => void
  /** Optimistic queued sends (owned by the route so they survive view switches). */
  pending: Array<{ id: string; text: string }>
  /** Controlled composer text (owned by the route so dictation can write to it). */
  composerText: string
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  inputLocked?: boolean
  filePaths?: string[]
  onNeedFiles?: () => void
  /** Active agent — selects the per-agent slash-command catalog in the composer. */
  agent?: string | null
  /** Discovered skills for `$` autocomplete (Codex only). */
  skills?: DiscoveredSkill[]
  onNeedSkills?: () => void
  /** A pending agent question/permission detected from live status, shown as a
   *  native card above the composer; answering sends text to the agent. */
  /** Structured AskUserQuestion prompt parsed from the transcript (preferred over
   *  the heuristic question card). */
  ask?: AskPrompt | null
  onAnswerAsk?: (text: string) => void
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string) => void
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => void
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
  isAttaching,
  onMicPress,
  micActive,
  inputLocked,
  filePaths,
  onNeedFiles,
  agent,
  skills,
  onNeedSkills,
  ask,
  onAnswerAsk,
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
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  const pendingIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending])
  // `data` is the list source: folded transcript + synthetic streaming bubble +
  // route-owned optimistic queued messages. Memoize on the same deps so the
  // downstream autoscroll effects/`renderItem` keep referential stability.
  const { data } = useMemo(
    () => buildMobileNativeChatData({ messages, streamingText, pending }),
    [messages, streamingText, pending]
  )

  // Follow the tail as the conversation grows, but only when already pinned to
  // the bottom — don't yank the user away while they read history.
  useEffect(() => {
    if (data.length === 0 || !atBottom) {
      return
    }
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
    return () => clearTimeout(t)
  }, [data.length, atBottom])

  // Keep the newest message visible above the keyboard when it opens.
  useEffect(() => {
    if (keyboardInset <= 0 || data.length === 0 || !atBottom) {
      return
    }
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60)
    return () => clearTimeout(t)
  }, [keyboardInset, data.length, atBottom])

  const handleSend = useCallback(
    (text: string) => {
      onSend(text)
      // Always jump to the newest message when the user sends.
      setAtBottom(true)
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60)
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

  const hint = statusHint(status, error)
  const showLoading = status === 'loading' && messages.length === 0

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
                hint ? (
                  <View style={styles.center}>
                    <Text style={styles.hint}>{hint}</Text>
                  </View>
                ) : status === 'ready' ? (
                  <View style={styles.center}>
                    <Text style={styles.hint}>No messages yet.</Text>
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
          onAnswer={(text) => {
            dismissAsk()
            onAnswerAsk?.(text)
          }}
          onCancel={() => {
            dismissAsk()
            onStop?.()
          }}
        />
      ) : permission ? (
        <MobileNativeChatPermission
          permission={permission}
          onRespond={(send) => onRespondPermission?.(send)}
        />
      ) : question ? (
        <MobileNativeChatQuestion
          question={question}
          onAnswer={(text) => onAnswerQuestion?.(text)}
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
      <MobileNativeChatComposer
        value={composerText}
        onChangeText={onComposerTextChange}
        onSend={handleSend}
        onAttachImage={onAttachImage}
        isAttaching={isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        disabled={inputLocked}
        placeholder={
          inputLocked ? 'Input is locked by another client' : 'Message, @files, /commands'
        }
        filePaths={filePaths}
        onNeedFiles={onNeedFiles}
        agent={agent}
        skills={skills}
        onNeedSkills={onNeedSkills}
      />
    </View>
  )
}
