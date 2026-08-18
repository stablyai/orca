import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { Square } from 'lucide-react-native'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHandoffStatus } from '../../../src/shared/agent-session-wire'
import { colors } from '../theme/mobile-theme'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import {
  MobileStructuredPromptCard,
  type MobileStructuredPromptItem
} from './MobileStructuredPromptCard'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'
import {
  buildMobileStructuredTimeline,
  activeMobileStructuredTurnId,
  mobileStructuredOutboxText,
  restoreMobileStructuredAttachments,
  type MobileStructuredTimelineRow
} from './mobile-structured-session-timeline'
import {
  admitStructuredOlderPage,
  beginStructuredUserScroll,
  createMobileStructuredPaginationState,
  finishStructuredPaginationMomentum,
  settleStructuredOlderPage
} from './mobile-structured-history-pagination'
import { styles } from './mobile-structured-agent-session-view-styles'
import { useMobileStructuredComposerState } from './use-mobile-structured-composer-state'
import {
  dispatchMobileStructuredComposerCommand,
  isMobileStructuredComposerCommand,
  mobileStructuredSlashCommands
} from './mobile-structured-composer-command'
import type { MobileStructuredAgent } from './mobile-structured-session-create'

type Props = {
  agent: MobileStructuredAgent
  items: AgentJournalRenderItem[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  writeError?: string | null
  hasOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => Promise<boolean>
  onOpenFile?: (path: string) => void
  outbox: MobileStructuredOutboxEntry[]
  onSend: (text: string, restored: readonly PendingNativeChatImage[]) => Promise<boolean>
  onTuiSend?: (text: string, restored: readonly PendingNativeChatImage[]) => Promise<boolean>
  onTakeQueuedForEdit: (clientMessageId: string) => Promise<MobileStructuredOutboxEntry | null>
  onRetry: (clientMessageId: string) => Promise<void>
  onRespondToPrompt: (item: MobileStructuredPromptItem, optionId: string) => Promise<boolean>
  sessionOptions: MobileNativeChatSessionOptionsController
  attachments: PendingNativeChatImage[]
  isAttaching: boolean
  onAttachImage: () => void
  onRemoveAttachment: (id: string) => void
  onCancel: (turnId: string) => Promise<boolean>
  handoff: AgentSessionHandoffStatus | null
}

export function MobileStructuredAgentSessionView(props: Props): React.JSX.Element {
  const listRef = useRef<FlatList<MobileStructuredTimelineRow>>(null)
  const paginationRef = useRef(createMobileStructuredPaginationState())
  const priorContentHeightRef = useRef(0)
  const androidAnchorOffsetRef = useRef(0)
  const { composerText, setComposerText, restored, setRestored } =
    useMobileStructuredComposerState()
  const [commandError, setCommandError] = useState<string | null>(null)
  const turnId = activeMobileStructuredTurnId(props.items)
  const allAttachments = [...restored, ...props.attachments]
  const agentName = props.agent === 'claude' ? 'Claude' : 'Codex'
  const slashCommands = useMemo(() => mobileStructuredSlashCommands(props.agent), [props.agent])
  const stableTuiOwner =
    props.handoff?.owner === 'tui' &&
    props.handoff.phase === 'idle' &&
    Boolean(props.handoff.terminal?.handle) &&
    Boolean(props.onTuiSend)
  const stableNativeOwner =
    props.handoff === null ||
    props.handoff === undefined ||
    (props.handoff.owner === 'native' && props.handoff.phase === 'idle')
  const composerEnabled = props.status === 'ready' && (stableNativeOwner || stableTuiOwner)
  const rows = useMemo(
    () => buildMobileStructuredTimeline(props.items, props.outbox),
    [props.items, props.outbox]
  )
  const data = rows.toReversed()

  const loadOlder = useCallback(() => {
    const pagination = paginationRef.current
    if (!props.hasOlder || props.loadingOlder || !admitStructuredOlderPage(pagination)) {
      return
    }
    void props.onLoadOlder().finally(() => settleStructuredOlderPage(pagination))
  }, [props])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    androidAnchorOffsetRef.current = event.nativeEvent.contentOffset.y
  }, [])

  if (props.status === 'loading' && data.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        inverted
        data={data}
        keyExtractor={(row) => row.key}
        renderItem={({ item, index }) =>
          item.kind === 'prompt' ? (
            <MobileStructuredPromptCard item={item.item} onRespond={props.onRespondToPrompt} />
          ) : (
            <MobileNativeChatMessage
              message={item.message}
              queued={Boolean(item.outbox)}
              deliveryState={item.outbox?.state}
              onQueuedPress={
                item.outbox?.state === 'queued' || item.outbox?.state === 'unconfirmed'
                  ? async () => {
                      const outbox = item.outbox
                      if (!outbox) {
                        return
                      }
                      if (outbox.state === 'unconfirmed') {
                        await props.onRetry(outbox.clientMessageId)
                        return
                      }
                      const editable = await props.onTakeQueuedForEdit(outbox.clientMessageId)
                      if (editable) {
                        setComposerText(mobileStructuredOutboxText(editable))
                        setRestored(restoreMobileStructuredAttachments(editable))
                      }
                    }
                  : undefined
              }
              messageIndex={data.length - index - 1}
              onOpenFile={props.onOpenFile}
            />
          )
        }
        contentContainerStyle={styles.content}
        maintainVisibleContentPosition={
          Platform.OS === 'android' ? undefined : { minIndexForVisible: 0 }
        }
        onScroll={onScroll}
        scrollEventThrottle={32}
        onScrollBeginDrag={() => beginStructuredUserScroll(paginationRef.current)}
        onMomentumScrollBegin={() => {
          if (!paginationRef.current.programmaticMomentum) {
            paginationRef.current.userMomentum = true
          }
        }}
        onMomentumScrollEnd={() => {
          const pagination = paginationRef.current
          finishStructuredPaginationMomentum(pagination, !pagination.programmaticMomentum)
        }}
        onEndReached={loadOlder}
        onEndReachedThreshold={0.2}
        onContentSizeChange={(_width, height) => {
          const priorHeight = priorContentHeightRef.current
          priorContentHeightRef.current = height
          if (Platform.OS !== 'android' || priorHeight === 0 || height <= priorHeight) {
            return
          }
          listRef.current?.scrollToOffset({
            offset: androidAnchorOffsetRef.current + height - priorHeight,
            animated: false
          })
        }}
        ListFooterComponent={
          props.loadingOlder ? (
            <View style={styles.loader}>
              <ActivityIndicator size="small" color={colors.textMuted} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.title}>
              {props.status === 'error' ? 'Conversation unavailable' : `New ${agentName} chat`}
            </Text>
            <Text style={styles.subtitle}>{props.error ?? 'Send a message to get started.'}</Text>
          </View>
        }
      />
      {turnId ? (
        <View style={styles.writeChrome}>
          <Pressable
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
            onPress={() => void props.onCancel(turnId)}
            accessibilityLabel="Stop the agent"
          >
            <Square size={13} color={colors.statusRed} strokeWidth={2.4} fill={colors.statusRed} />
            <Text style={styles.cancelText}>Stop</Text>
          </Pressable>
        </View>
      ) : null}
      {commandError || props.writeError ? (
        <View style={styles.writeError} accessibilityRole="alert">
          <Text style={styles.writeErrorText}>{commandError ?? props.writeError}</Text>
        </View>
      ) : null}
      <MobileNativeChatComposer
        value={composerText}
        onChangeText={setComposerText}
        onSend={async (text) => {
          if (!composerEnabled) {
            setCommandError('Session ownership is changing. Try again when switching finishes.')
            return false
          }
          if (allAttachments.length > 0 && isMobileStructuredComposerCommand(text, props.agent)) {
            setCommandError('Remove attachments before using a chat-session command.')
            return false
          }
          if (stableTuiOwner) {
            setCommandError(null)
            const accepted = await props.onTuiSend!(text, restored)
            if (accepted) {
              setComposerText('')
              setRestored([])
            }
            return accepted
          }
          const command = await dispatchMobileStructuredComposerCommand(
            text,
            props.sessionOptions,
            props.agent
          )
          if (command.handled) {
            setCommandError(command.error)
            if (command.accepted) {
              setComposerText('')
            }
            return command.accepted
          }
          setCommandError(null)
          const accepted = await props.onSend(text, restored)
          if (accepted) {
            setComposerText('')
            setRestored([])
          }
          return accepted
        }}
        agent={props.agent}
        slashCommands={slashCommands}
        sessionOptions={{ controller: props.sessionOptions, isWorking: false }}
        onAttachImage={props.onAttachImage}
        attachments={allAttachments}
        onRemoveAttachment={(id) => {
          if (id.startsWith('restored:')) {
            setRestored((current) => current.filter((entry) => entry.id !== id))
          } else {
            props.onRemoveAttachment(id)
          }
        }}
        isAttaching={props.isAttaching}
        disabled={!composerEnabled}
        placeholder={
          props.handoff?.owner === 'tui' && !stableTuiOwner
            ? 'Agent is open in terminal'
            : props.status === 'ready'
              ? `Message ${agentName}`
              : 'Reconnecting…'
        }
      />
    </View>
  )
}
