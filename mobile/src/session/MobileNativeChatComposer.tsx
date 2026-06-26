import { useMemo, useState } from 'react'
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
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  applyAutocomplete,
  detectAutocompleteTrigger,
  rankSuggestions
} from './mobile-native-chat-autocomplete'
import {
  getAgentSlashCommands,
  type SlashCommandSuggestion
} from '../../../src/shared/native-chat-slash-commands'
import type { DiscoveredSkill } from '../../../src/shared/skills'

const NO_FILE_PATHS: string[] = []
const NO_SKILLS: DiscoveredSkill[] = []

/** A row in the suggestion list: the text to insert plus an optional one-line
 *  description (shown for slash commands and skills, like desktop). */
type SuggestionRow = { value: string; description?: string }

type Props = {
  /** Controlled composer text — owned by the parent so dictation can write to it. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  onAttachImage?: () => void
  isAttaching?: boolean
  onMicPress?: () => void
  micActive?: boolean
  disabled?: boolean
  placeholder?: string
  filePaths?: string[]
  onNeedFiles?: () => void
  /** Active agent — selects the per-agent slash-command catalog. */
  agent?: string | null
  /** Discovered skills for `$` autocomplete (Codex only; empty otherwise). */
  skills?: DiscoveredSkill[]
  /** Called when the user opens a `$` skill token, so the route can lazily
   *  discover skills (mirrors onNeedFiles). */
  onNeedSkills?: () => void
}

export function MobileNativeChatComposer({
  value,
  onChangeText,
  onSend,
  onAttachImage,
  isAttaching = false,
  onMicPress,
  micActive = false,
  disabled = false,
  placeholder = 'Message, @files, /commands',
  filePaths = NO_FILE_PATHS,
  onNeedFiles,
  agent = null,
  skills = NO_SKILLS,
  onNeedSkills
}: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(0)
  const trimmed = value.trim()
  const canSend = trimmed.length > 0 && !disabled

  const slashCommands = useMemo(() => (agent ? getAgentSlashCommands(agent) : []), [agent])
  const trigger = useMemo(() => detectAutocompleteTrigger(value, cursor), [value, cursor])
  const suggestions = useMemo<SuggestionRow[]>(() => {
    if (!trigger) {
      return []
    }
    if (trigger.kind === 'slash') {
      // Rank by the bare command name, then render `/name` with its description.
      const names = slashCommands.map((c) => c.name)
      const byName = new Map<string, SlashCommandSuggestion>(slashCommands.map((c) => [c.name, c]))
      return rankSuggestions(names, trigger.query).map((name) => ({
        value: `/${name}`,
        description: byName.get(name)?.description
      }))
    }
    if (trigger.kind === 'skill') {
      // Only installed skills are insertable; mirror desktop's filter.
      const installed = skills.filter((s) => s.installed)
      const names = installed.map((s) => s.name)
      const byName = new Map<string, DiscoveredSkill>(installed.map((s) => [s.name, s]))
      return rankSuggestions(names, trigger.query).map((name) => ({
        value: `$${name}`,
        description: byName.get(name)?.sourceLabel
      }))
    }
    return rankSuggestions(filePaths, trigger.query).map((p) => ({ value: `@${p}` }))
  }, [trigger, filePaths, slashCommands, skills])

  const handleChange = (next: string): void => {
    onChangeText(next)
    if (onNeedFiles && filePaths.length === 0 && next.includes('@')) {
      onNeedFiles()
    }
    if (onNeedSkills && skills.length === 0 && next.includes('$')) {
      onNeedSkills()
    }
  }

  const pickSuggestion = (suggestion: string): void => {
    if (!trigger) {
      return
    }
    const { text: nextText, cursor: nextCursor } = applyAutocomplete(value, trigger, suggestion)
    onChangeText(nextText)
    setCursor(nextCursor)
  }

  const handleSend = (): void => {
    if (!canSend) {
      return
    }
    onSend(trimmed)
    onChangeText('')
    setCursor(0)
  }

  return (
    <View>
      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestionScroll}>
            {suggestions.map((s) => (
              <Pressable
                key={s.value}
                style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
                onPress={() => pickSuggestion(s.value)}
              >
                <Text style={styles.suggestionText} numberOfLines={1}>
                  {s.value}
                </Text>
                {s.description ? (
                  <Text style={styles.suggestionDescription} numberOfLines={1}>
                    {s.description}
                  </Text>
                ) : null}
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
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
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
            onPress={onMicPress}
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
  suggestionDescription: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 1
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
