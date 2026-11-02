import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  TextInput,
  View
} from 'react-native'
import { ArrowUp, ImagePlus, Mic, Square, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { structuredSlashCommands } from '../../../src/shared/structured-agent-session-composer'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSlashCommandSuggestions,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import {
  composerSuggestionInsertText,
  MobileNativeChatComposerSuggestions,
  type ComposerSuggestion
} from './MobileNativeChatComposerSuggestions'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation,
  type MobileNativeChatSessionOptionPickersProps
} from './MobileNativeChatSessionOptionPickers'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { mobileNativeChatInputStyles } from './mobile-native-chat-input-styles'
import { getMobileNativeChatCommands } from './mobile-native-chat-send-classification'
import { keepHeldPressThroughLongPress } from './held-press-long-press'
import {
  mobileNativeChatComposerExpanded,
  mobileNativeChatComposerShowsStop
} from './mobile-native-chat-composer-layout'
import { MobileNativeChatStopButton } from './MobileNativeChatStopButton'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []

type Props = {
  /** Lets the owner focus the field, e.g. after Edit moves a queued message into it. */
  inputRef?: React.RefObject<TextInput | null>
  structuredCommands?: readonly AgentSessionConversationCommand[]
  /** Controlled composer text — owned by the parent so dictation can write to it. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => Promise<boolean>
  /** Changes whenever the route focuses a different chat composer surface. */
  sendSurfaceId: string
  /** Reads the retained route's focus generation without forcing a screen render. */
  getSendCompletionGeneration: () => number
  /** Reads user draft mutations owned above this renderable composer. */
  getComposerEditGeneration: () => number
  /** Active tab's agent — the slash autocomplete serves its command catalog. */
  agent?: string | null
  /** Model/session-option pickers shown in the composer action row; null when
   *  the agent has no session-option catalog. */
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  onAttachImage?: () => void
  /** Images picked-and-uploaded but not yet sent — shown as removable thumbnails
   *  and ridden along on the next send (desktop native-chat parity). */
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  /** Dictation trigger style — 'hold' uses press-in/out, 'toggle' uses tap. */
  dictationMode?: string
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  disabled?: boolean
  /** Only Send is unavailable; typing, dictation and attachments still edit the draft. */
  sendDisabled?: boolean
  placeholder?: string
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  /** Set while the agent can be stopped; Stop takes Send's slot when Send can't deliver. */
  stop?: { onStop?: () => void; held: boolean } | null
}

export function MobileNativeChatComposer({
  inputRef,
  value,
  onChangeText,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  agent,
  structuredCommands,
  sessionOptions,
  onAttachImage,
  attachments = NO_ATTACHMENTS,
  onRemoveAttachment,
  isAttaching = false,
  onMicPress,
  micActive = false,
  dictationMode = 'toggle',
  onMicPressIn,
  onMicPressOut,
  disabled = false,
  sendDisabled = false,
  placeholder = 'Message, @files, /commands',
  filePaths = NO_FILE_PATHS,
  onNeedFiles,
  stop = null
}: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
  const fallbackInputRef = useRef<TextInput>(null)
  const fieldRef = inputRef ?? fallbackInputRef
  const [focused, setFocused] = useState(false)
  const [picker, setPicker] = useState<MobileNativeChatPickerPresentation | null>(null)
  const request = sessionOptions?.controller.optionPickerRequest
  const [lastRequest, setLastRequest] = useState(request)
  if (request && lastRequest !== request) {
    setLastRequest(request)
    setPicker({ page: request.id, refocus: false })
  }
  // Transiently drives the native caret after a mid-text autocomplete insert,
  // then released on the next selection change so manual caret placement still
  // works (a permanently controlled `selection` breaks it in React Native).
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(
    null
  )
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  const sendSurfaceIdRef = useRef(sendSurfaceId)
  const sendSurfaceGenerationRef = useRef(0)
  useLayoutEffect(() => {
    if (sendSurfaceIdRef.current !== sendSurfaceId) {
      sendSurfaceIdRef.current = sendSurfaceId
      sendSurfaceGenerationRef.current += 1
    }
  }, [sendSurfaceId])
  const [sending, setSending] = useState(false)
  const trimmed = value.trim()
  const sessionOptionDispatching = sessionOptions?.controller.pendingId != null
  // An attached image alone is a valid send (desktop parity), so the image rides
  // along even when the user sends no accompanying text.
  const canSend =
    (trimmed.length > 0 || attachments.length > 0) &&
    !disabled &&
    !sendDisabled &&
    !sending &&
    !isAttaching &&
    !sessionOptionDispatching
  const composerContent = { draft: value, attachmentCount: attachments.length }
  const pickerOpen = picker !== null && sessionOptions != null
  const expanded = mobileNativeChatComposerExpanded({ focused, pickerOpen, ...composerContent })
  const showsStop = mobileNativeChatComposerShowsStop({
    canStop: stop !== null,
    sendBlocked: sendDisabled,
    canSend,
    editing: isAttaching || micActive,
    ...composerContent
  })

  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger) {
      return []
    }
    if (trigger.kind === 'slash') {
      const commands =
        structuredCommands !== undefined
          ? structuredSlashCommands(structuredCommands, agent)
          : agent
            ? getMobileNativeChatCommands(agent)
            : []
      // Why: Codex's catalog is 45 commands and this list is a plain ScrollView
      // (~5 rows visible), so an uncapped `/` would mount every row and
      // re-reconcile them on each streaming tick right above the transcript.
      return rankSlashCommandSuggestions(commands, trigger.query, 12).map((command) => ({
        kind: 'command' as const,
        command
      }))
    }
    return rankSuggestions(filePaths, trigger.query).map((path) => ({
      kind: 'file' as const,
      path
    }))
  }, [trigger, filePaths, agent, structuredCommands])

  useEffect(() => {
    if (trigger?.kind === 'file') {
      onNeedFiles?.(trigger.query)
    }
  }, [onNeedFiles, trigger?.kind, trigger?.query])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sendSurfaceGenerationRef.current += 1
    }
  }, [])

  const handleChange = (next: string): void => {
    onChangeText(next)
  }

  const pickSuggestion = (suggestion: ComposerSuggestion): void => {
    if (!trigger) {
      return
    }
    const { text: nextText, cursor: nextCursor } = applyAutocomplete(
      value,
      trigger,
      composerSuggestionInsertText(suggestion)
    )
    onChangeText(nextText)
    setCursor(nextCursor)
    setPendingSelection({ start: nextCursor, end: nextCursor })
  }

  const handleSend = async (): Promise<void> => {
    if (!canSend || sendingRef.current) {
      return
    }
    sendingRef.current = true
    setSending(true)
    const sendSurfaceGeneration = sendSurfaceGenerationRef.current
    const sendCompletionGeneration = getSendCompletionGeneration()
    const composerEditGeneration = getComposerEditGeneration()
    try {
      // Raw, not trimmed: the send seam owns the wire trim, and a rejection has
      // to hand the user back exactly what they typed (#14819).
      const accepted = await onSend(value)
      if (
        accepted &&
        mountedRef.current &&
        sendSurfaceGeneration === sendSurfaceGenerationRef.current &&
        sendCompletionGeneration === getSendCompletionGeneration() &&
        composerEditGeneration === getComposerEditGeneration()
      ) {
        setCursor(0)
        // Why: the turn is now the agent's — the keyboard would cover the reply.
        // A rejected send keeps it up so the handed-back draft stays editable.
        Keyboard.dismiss()
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const attachButton = onAttachImage ? (
    <Pressable
      accessibilityLabel="Attach image"
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      onPress={onAttachImage}
      disabled={isAttaching || disabled}
    >
      {isAttaching ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <ImagePlus size={20} color={colors.textSecondary} strokeWidth={2} />
      )}
    </Pressable>
  ) : null

  return (
    <View>
      {suggestions.length > 0 ? (
        <MobileNativeChatComposerSuggestions suggestions={suggestions} onPick={pickSuggestion} />
      ) : null}
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={styles.attachmentStrip}
          contentContainerStyle={styles.attachmentStripContent}
        >
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.attachmentThumb}>
              <Image
                source={{ uri: attachment.previewUri }}
                style={styles.attachmentImage}
                resizeMode="cover"
              />
              {onRemoveAttachment ? (
                <Pressable
                  accessibilityLabel="Remove image"
                  style={styles.attachmentRemove}
                  onPress={() => onRemoveAttachment(attachment.id)}
                  hitSlop={8}
                >
                  <X size={12} color={colors.textPrimary} strokeWidth={2.6} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.composerInset} testID="native-chat-composer-inset">
        <View style={expanded ? styles.bar : styles.barCollapsed} testID="native-chat-composer">
          {/* Collapsed puts attach before the field; the field keeps its child slot either way so
              the switch never remounts it (that would drop focus mid-tap). */}
          {expanded ? null : attachButton}
          <TextInput
            ref={fieldRef}
            style={
              expanded
                ? mobileNativeChatInputStyles.input
                : [mobileNativeChatInputStyles.freeInput, styles.inputCollapsed]
            }
            value={value}
            onChangeText={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // Controlled only transiently right after an autocomplete insert.
            selection={pendingSelection ?? undefined}
            onSelectionChange={(e) => {
              setCursor(e.nativeEvent.selection.end)
              setPendingSelection(null)
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            multiline
            // Why: never revoke `editable` — iOS resigns first responder on a focused
            // field, so a transient lock would yank the keyboard mid-typing (#10681).
            // The lock gates sending; the draft survives and rides the next send.
            textAlignVertical="top"
          />
          <View
            style={expanded ? styles.actionRow : styles.actionRowCollapsed}
            testID="native-chat-composer-actions"
          >
            {expanded ? attachButton : null}
            {sessionOptions ? (
              // Stays mounted collapsed so an open drawer, or a picker a command asks for, survives.
              <MobileNativeChatSessionOptionPickers
                {...sessionOptions}
                sendInFlight={sending || isAttaching}
                pillsHidden={!expanded}
                presentation={picker}
                onNavigate={(page) => setPicker((current) => current && { ...current, page })}
                onDrawerOpen={(page) => setPicker({ page, refocus: focused })}
                onDrawerAfterClose={() => {
                  if (picker?.refocus) {
                    fieldRef.current?.focus()
                  }
                  setPicker(null)
                }}
              />
            ) : null}
            {expanded ? <View style={styles.actionSpacer} /> : null}
            {onMicPress ? (
              <Pressable
                accessibilityLabel={micActive ? 'Stop dictation' : 'Dictate'}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
                onPress={dictationMode === 'hold' ? undefined : onMicPress}
                onPressIn={dictationMode === 'hold' ? onMicPressIn : undefined}
                onPressOut={dictationMode === 'hold' ? onMicPressOut : undefined}
                onLongPress={dictationMode === 'hold' ? keepHeldPressThroughLongPress : undefined}
                disabled={disabled && !micActive}
              >
                {/* The icon swaps on press; as the page's touch target, its removal would send
                    touchend to a detached node and lose the release. */}
                {micActive ? (
                  <Square
                    pointerEvents="none"
                    size={18}
                    color={colors.statusRed}
                    strokeWidth={2.4}
                    fill={colors.statusRed}
                  />
                ) : (
                  <Mic
                    pointerEvents="none"
                    size={20}
                    color={colors.textSecondary}
                    strokeWidth={2}
                  />
                )}
              </Pressable>
            ) : null}
            {showsStop && stop ? (
              // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
              <MobileNativeChatStopButton onStop={stop.onStop} held={stop.held} />
            ) : (
              <Pressable
                accessibilityLabel="Send message"
                style={({ pressed }) => [
                  styles.sendButton,
                  !canSend && styles.sendButtonDisabled,
                  pressed && canSend && styles.pressed
                ]}
                onPress={handleSend}
                disabled={!canSend}
              >
                <ArrowUp
                  size={20}
                  color={canSend ? colors.bgBase : colors.textMuted}
                  strokeWidth={2.6}
                />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  )
}
