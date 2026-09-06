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
import { MobileNativeChatHardwareSubmit } from './MobileNativeChatHardwareSubmit'
import { isHardwareKeyboardConnected } from '@orca/expo-hardware-keyboard-navigation'
import { useHardwareKeyboardTextInputFocus } from '../hardware-keyboard/use-hardware-keyboard-text-input-focus'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-composer-styles'
import { getVerifiedNativeChatCommands } from '../../../src/shared/native-chat-agent-profiles'
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
  type MobileNativeChatSessionOptionPickersProps
} from './MobileNativeChatSessionOptionPickers'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []

type Props = {
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
  dictationMode?: 'toggle' | 'hold'
  onMicPressIn?: () => void
  onMicPressOut?: () => void
  disabled?: boolean
  placeholder?: string
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
}

export function MobileNativeChatComposer({
  value,
  onChangeText,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  agent,
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
  placeholder = 'Message, @files, /commands',
  filePaths = NO_FILE_PATHS,
  onNeedFiles
}: Props): React.JSX.Element {
  const inputRef = useRef<TextInput>(null)
  const inputValueRef = useRef(value)
  useLayoutEffect(() => {
    inputValueRef.current = value
  }, [value])
  const hardwareFocus = useHardwareKeyboardTextInputFocus({
    enabled: !disabled,
    inputRef,
    surfaceId: sendSurfaceId
  })
  const [cursor, setCursor] = useState(0)
  // Release autocomplete's caret override on the next native selection change.
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
  // An attached image alone is a valid send (desktop parity), so the image rides
  // along even when the user sends no accompanying text.
  const canSend =
    (value.trim().length > 0 || attachments.length > 0) &&
    !disabled &&
    !sending &&
    !isAttaching &&
    sessionOptions?.controller.pendingId == null

  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger) {
      return []
    }
    if (trigger.kind === 'slash') {
      const commands = agent ? getVerifiedNativeChatCommands(agent) : []
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
  }, [trigger, filePaths, agent])

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
    inputValueRef.current = next
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
    handleChange(nextText)
    setCursor(nextCursor)
    setPendingSelection({ start: nextCursor, end: nextCursor })
  }

  const handleSend = async (source: 'hardware' | 'touch' = 'touch'): Promise<void> => {
    const text = source === 'hardware' ? inputValueRef.current : value
    if (
      (text.trim().length === 0 && attachments.length === 0) ||
      disabled ||
      sending ||
      isAttaching ||
      sessionOptions?.controller.pendingId != null ||
      sendingRef.current
    ) {
      return
    }
    sendingRef.current = true
    setSending(true)
    const sendSurfaceGeneration = sendSurfaceGenerationRef.current
    const sendCompletionGeneration = getSendCompletionGeneration()
    const composerEditGeneration = getComposerEditGeneration()
    try {
      // Preserve the verbatim draft on rejected sends (#14819).
      const accepted = await onSend(text)
      if (
        accepted &&
        mountedRef.current &&
        sendSurfaceGeneration === sendSurfaceGenerationRef.current &&
        sendCompletionGeneration === getSendCompletionGeneration() &&
        composerEditGeneration === getComposerEditGeneration()
      ) {
        setCursor(0)
        // Keep hardware input focused for the next message.
        if (source !== 'hardware' && !isHardwareKeyboardConnected()) {
          Keyboard.dismiss()
        }
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

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
        <View style={styles.bar} testID="native-chat-composer">
          <MobileNativeChatHardwareSubmit
            enabled={!disabled}
            onSubmit={() => handleSend('hardware')}
          >
            <TextInput
              ref={inputRef}
              showSoftInputOnFocus={hardwareFocus.showSoftInputOnFocus}
              onTouchStart={hardwareFocus.handleTouchStart}
              style={styles.input}
              value={value}
              onChangeText={handleChange}
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
              // Gate sends without revoking editable and resigning iOS focus (#10681).
              textAlignVertical="top"
            />
          </MobileNativeChatHardwareSubmit>
          <View style={styles.actionRow} testID="native-chat-composer-actions">
            {onAttachImage ? (
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
            ) : null}
            {sessionOptions ? (
              <MobileNativeChatSessionOptionPickers
                {...sessionOptions}
                sendInFlight={sending || isAttaching}
              />
            ) : null}
            <View style={styles.actionSpacer} />
            {onMicPress ? (
              <Pressable
                accessibilityLabel={micActive ? 'Stop dictation' : 'Dictate'}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                // Hold mode is walkie-talkie (press-in/out); toggle mode taps.
                onPress={dictationMode === 'hold' ? undefined : onMicPress}
                onPressIn={dictationMode === 'hold' ? onMicPressIn : undefined}
                onPressOut={dictationMode === 'hold' ? onMicPressOut : undefined}
                disabled={disabled}
              >
                {micActive ? (
                  <Square
                    size={18}
                    color={colors.statusRed}
                    strokeWidth={2.4}
                    fill={colors.statusRed}
                  />
                ) : (
                  <Mic size={20} color={colors.textSecondary} strokeWidth={2} />
                )}
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Send message"
              style={({ pressed }) => [
                styles.sendButton,
                !canSend && styles.sendButtonDisabled,
                pressed && canSend && styles.pressed
              ]}
              onPress={() => handleSend()}
              disabled={!canSend}
            >
              <ArrowUp
                size={20}
                color={canSend ? colors.bgBase : colors.textMuted}
                strokeWidth={2.6}
              />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  )
}
