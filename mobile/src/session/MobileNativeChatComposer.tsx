import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { ArrowUp, ImagePlus, Mic, Square } from 'lucide-react-native'
import type { AgentType } from '../../../src/shared/agent-status-types'
import {
  applyMentionSuggestion,
  editReplacesTriggerToken,
  type NativeChatPickerItem
} from '../../../src/shared/native-chat/native-chat-composer-state'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  deriveMobileNativeChatAutocomplete,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import { MobileNativeChatPickerStrip } from './MobileNativeChatPickerStrip'
import { insertMobileNativeChatPickerItem } from './mobile-native-chat-strip'
import type { MobileNativeChatSkillDiscovery } from './use-mobile-native-chat-skills'

const NO_FILE_PATHS: string[] = []
const EMPTY_SKILL_DISCOVERY: MobileNativeChatSkillDiscovery = {
  status: 'idle',
  skills: [],
  retry: () => {}
}

type Props = {
  /** Controlled composer text — owned by the parent so dictation can write to it. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => Promise<boolean>
  onAttachImage?: () => void
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
  agent?: AgentType | null
  skillDiscovery?: MobileNativeChatSkillDiscovery
  onPickerTextChange?: (text: string) => void
  dismissAutocompleteSignal?: number
}

export function MobileNativeChatComposer({
  value,
  onChangeText,
  onSend,
  onAttachImage,
  isAttaching = false,
  onMicPress,
  micActive = false,
  dictationMode = 'toggle',
  onMicPressIn,
  onMicPressOut,
  disabled = false,
  placeholder = 'Message, @files, /commands',
  filePaths = NO_FILE_PATHS,
  onNeedFiles,
  agent = null,
  skillDiscovery = EMPTY_SKILL_DISCOVERY,
  onPickerTextChange,
  dismissAutocompleteSignal = 0
}: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null)
  const dismissalSignalRef = useRef(dismissAutocompleteSignal)
  // Transiently drives the native caret after a mid-text autocomplete insert,
  // then released on the next selection change so manual caret placement still
  // works (a permanently controlled `selection` breaks it in React Native).
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(
    null
  )
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const trimmed = value.trim()
  const canSend = trimmed.length > 0 && !disabled && !sending && !isAttaching

  const rawAutocomplete = useMemo(
    () => deriveMobileNativeChatAutocomplete(value, cursor, agent, skillDiscovery),
    [agent, cursor, skillDiscovery, value]
  )
  const autocomplete = useMemo(
    () =>
      dismissedTriggerKey
        ? deriveMobileNativeChatAutocomplete(
            value,
            cursor,
            agent,
            skillDiscovery,
            dismissedTriggerKey
          )
        : rawAutocomplete,
    [agent, cursor, dismissedTriggerKey, rawAutocomplete, skillDiscovery, value]
  )
  const fileSuggestions = useMemo(
    () =>
      autocomplete.mode === 'mention'
        ? rankSuggestions(filePaths, autocomplete.query)
        : NO_FILE_PATHS,
    [autocomplete, filePaths]
  )

  useEffect(() => {
    if (
      dismissedTriggerKey &&
      (rawAutocomplete.mode === 'none' ||
        rawAutocomplete.mode === 'mention' ||
        rawAutocomplete.triggerKey !== dismissedTriggerKey)
    ) {
      setDismissedTriggerKey(null)
    }
  }, [dismissedTriggerKey, rawAutocomplete])

  useEffect(() => {
    if (dismissalSignalRef.current === dismissAutocompleteSignal) {
      return
    }
    dismissalSignalRef.current = dismissAutocompleteSignal
    if (rawAutocomplete.mode === 'slash' || rawAutocomplete.mode === 'skill') {
      setDismissedTriggerKey(rawAutocomplete.triggerKey)
    }
  }, [dismissAutocompleteSignal, rawAutocomplete])

  useEffect(() => {
    if (autocomplete.mode === 'mention') {
      onNeedFiles?.(autocomplete.query)
    }
  }, [autocomplete, onNeedFiles])

  const handleChange = (next: string): void => {
    if (dismissedTriggerKey && editReplacesTriggerToken(value, next, dismissedTriggerKey)) {
      setDismissedTriggerKey(null)
    }
    onChangeText(next)
  }

  const writePickerText = (text: string, nextCursor: number): void => {
    const writeText = onPickerTextChange ?? onChangeText
    writeText(text)
    setCursor(nextCursor)
    setPendingSelection({ start: nextCursor, end: nextCursor })
    setDismissedTriggerKey(null)
  }

  const pickFileSuggestion = (path: string): void => {
    if (autocomplete.mode !== 'mention') {
      return
    }
    const result = applyMentionSuggestion(value, cursor, path)
    writePickerText(result.draft, result.caret)
  }

  const pickPickerItem = (item: NativeChatPickerItem): void => {
    if (autocomplete.mode !== 'slash' && autocomplete.mode !== 'skill') {
      return
    }
    const result = insertMobileNativeChatPickerItem(value, cursor, autocomplete, item)
    if (result.insertedToken) {
      writePickerText(result.text, result.cursor)
    }
  }

  const dismissPicker = (): void => {
    if (rawAutocomplete.mode === 'slash' || rawAutocomplete.mode === 'skill') {
      setDismissedTriggerKey(rawAutocomplete.triggerKey)
    }
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
      {autocomplete.mode === 'slash' || autocomplete.mode === 'skill' ? (
        <MobileNativeChatPickerStrip
          autocomplete={autocomplete}
          onChoose={pickPickerItem}
          onRetry={skillDiscovery.retry}
        />
      ) : null}
      {fileSuggestions.length > 0 ? (
        <View style={styles.suggestions}>
          <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestionScroll}>
            {fileSuggestions.map((path) => (
              <Pressable
                key={path}
                style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
                onPress={() => pickFileSuggestion(path)}
              >
                <Text style={styles.suggestionText} numberOfLines={1}>
                  @{path}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
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
          onPressIn={dismissPicker}
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
