import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { SlashCommandSuggestion } from '../../../src/shared/native-chat-slash-commands'

/** One row of the composer autocomplete: an agent slash command (with its
 *  catalog description, desktop parity), a session-reported skill, or a
 *  worktree file path. */
export type ComposerSuggestion =
  | { kind: 'command'; command: SlashCommandSuggestion }
  | { kind: 'skill'; skill: SlashCommandSuggestion }
  | { kind: 'file'; path: string }

export function composerSuggestionKey(suggestion: ComposerSuggestion): string {
  if (suggestion.kind === 'command') {
    return `command:${suggestion.command.name}`
  }
  return suggestion.kind === 'skill' ? `skill:${suggestion.skill.name}` : `file:${suggestion.path}`
}

/** The text the suggestion inserts at the trigger span. */
export function composerSuggestionInsertText(suggestion: ComposerSuggestion): string {
  if (suggestion.kind === 'command') {
    return `/${suggestion.command.name}`
  }
  return suggestion.kind === 'skill' ? `/${suggestion.skill.name}` : `@${suggestion.path}`
}

export function MobileNativeChatComposerSuggestions({
  suggestions,
  onPick
}: {
  suggestions: readonly ComposerSuggestion[]
  onPick: (suggestion: ComposerSuggestion) => void
}): React.JSX.Element {
  return (
    <View style={styles.suggestions}>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.suggestionScroll}>
        {suggestions.map((suggestion) => (
          <Pressable
            key={composerSuggestionKey(suggestion)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            onPress={() => onPick(suggestion)}
          >
            <View style={styles.suggestionTitle}>
              <Text style={styles.suggestionText} numberOfLines={1}>
                {composerSuggestionInsertText(suggestion)}
              </Text>
              {suggestion.kind === 'skill' ? <Text style={styles.skillTag}>skill</Text> : null}
            </View>
            {suggestion.kind === 'command' && suggestion.command.description ? (
              <Text style={styles.suggestionDescription} numberOfLines={1}>
                {suggestion.command.description}
              </Text>
            ) : null}
            {suggestion.kind === 'skill' && suggestion.skill.description ? (
              <Text style={styles.suggestionDescription} numberOfLines={1}>
                {suggestion.skill.description}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
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
    maxHeight: 220
  },
  suggestion: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    gap: 1
  },
  suggestionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  skillTag: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    paddingHorizontal: spacing.xs,
    overflow: 'hidden'
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
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
})
