import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { SlashCommandSuggestion } from '../../../src/shared/native-chat-slash-commands'

/** One row of the composer autocomplete: an agent slash command (with its
 *  catalog description, desktop parity) or a worktree file path. */
export type ComposerSuggestion =
  | { kind: 'command'; command: SlashCommandSuggestion }
  | { kind: 'file'; path: string }

export function composerSuggestionKey(suggestion: ComposerSuggestion): string {
  return suggestion.kind === 'command'
    ? `command:${suggestion.command.name}`
    : `file:${suggestion.path}`
}

/** The text the suggestion inserts at the trigger span. */
export function composerSuggestionInsertText(suggestion: ComposerSuggestion): string {
  return suggestion.kind === 'command' ? `/${suggestion.command.name}` : `@${suggestion.path}`
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
            <Text style={styles.suggestionText} numberOfLines={1}>
              {composerSuggestionInsertText(suggestion)}
            </Text>
            {suggestion.kind === 'command' && suggestion.command.description ? (
              <Text style={styles.suggestionDescription} numberOfLines={1}>
                {suggestion.command.description}
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
