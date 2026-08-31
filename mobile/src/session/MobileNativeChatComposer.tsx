import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View
} from 'react-native'
import { ArrowUp, ImagePlus, Mic, Square, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
  const [cursor, setCursor] = useState(0)
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
    !sending &&
    !isAttaching &&
    !sessionOptionDispatching

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
          <TextInput
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
            // Why: never revoke `editable` — iOS resigns first responder on a focused
            // field, so a transient lock would yank the keyboard mid-typing (#10681).
            // The lock gates sending; the draft survives and rides the next send.
            textAlignVertical="top"
          />
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
              onPress={handleSend}
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

const styles = StyleSheet.create({
  attachmentStrip: {
    maxHeight: 76,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  attachmentStripContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  attachmentThumb: {
    width: 60,
    height: 60,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  attachmentImage: {
    width: '100%',
    height: '100%',
    borderRadius: radii.button
  },
  attachmentRemove: {
    // Inset inside the thumb: Android drops touches outside the parent's bounds,
    // so an overhanging badge would lose part of its tap target.
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  composerInset: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  bar: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  actionRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  actionSpacer: {
    flex: 1
  },
  input: {
    width: '100%',
    maxHeight: 140,
    minHeight: 40,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    // White send affordance per design — dark arrow on a light circle.
    backgroundColor: colors.textPrimary
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
