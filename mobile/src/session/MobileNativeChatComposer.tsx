import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { ArrowUp, ImagePlus, Mic, Square, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

// Common agent slash commands offered as autocomplete; sending them is just text
// to the agent's terminal, so the set is intentionally provider-agnostic.
const SLASH_COMMANDS = [
  '/clear',
  '/compact',
  '/review',
  '/model',
  '/help',
  '/init',
  '/cost',
  '/diff'
]

const NO_FILE_PATHS: string[] = []
const NO_ATTACHMENTS: PendingNativeChatImage[] = []

type Props = {
  /** Controlled composer text — owned by the parent so dictation can write to it. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => Promise<boolean>
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
  const [sending, setSending] = useState(false)
  const trimmed = value.trim()
  // An attached image alone is a valid send (desktop parity), so the image rides
  // along even when the user sends no accompanying text.
  const canSend =
    (trimmed.length > 0 || attachments.length > 0) && !disabled && !sending && !isAttaching

  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const suggestions = useMemo(() => {
    if (!trigger) {
      return []
    }
    if (trigger.kind === 'slash') {
      return rankSuggestions(SLASH_COMMANDS, trigger.query)
    }
    return rankSuggestions(filePaths, trigger.query).map((p) => `@${p}`)
  }, [trigger, filePaths])

  useEffect(() => {
    if (trigger?.kind === 'file') {
      onNeedFiles?.(trigger.query)
    }
  }, [onNeedFiles, trigger?.kind, trigger?.query])

  const handleChange = (next: string): void => {
    onChangeText(next)
  }

  const pickSuggestion = (suggestion: string): void => {
    if (!trigger) {
      return
    }
    const { text: nextText, cursor: nextCursor } = applyAutocomplete(value, trigger, suggestion)
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
    try {
      const accepted = await onSend(trimmed)
      if (accepted) {
        setCursor(0)
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <View>
      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestionScroll}>
            {suggestions.map((s) => (
              <Pressable
                key={s}
                style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
                onPress={() => pickSuggestion(s)}
              >
                <Text style={styles.suggestionText} numberOfLines={1}>
                  {s}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
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
      <View style={styles.bar}>
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
          editable={!disabled}
          textAlignVertical="top"
        />
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
          <ArrowUp size={20} color={canSend ? colors.bgBase : colors.textMuted} strokeWidth={2.6} />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  suggestionScroll: {
    maxHeight: 180
  },
  suggestion: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  suggestionPressed: {
    backgroundColor: colors.bgRaised
  },
  suggestionText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
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
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  input: {
    flex: 1,
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
