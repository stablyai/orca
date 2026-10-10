import { memo, useCallback } from 'react'
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  type SectionListData,
  type SectionListRenderItem
} from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { NativeChatPickerItem } from '../../../src/shared/native-chat-picker-items'

/** One row of the composer autocomplete: a `/` menu command or skill (desktop's
 *  picker row) or a worktree file path. */
export type ComposerSuggestion =
  | { kind: 'picker'; item: NativeChatPickerItem }
  | { kind: 'file'; path: string }

export type ComposerSuggestionSection = {
  key: string
  /** Group heading; null for an ungrouped list. */
  title: string | null
  data: readonly ComposerSuggestion[]
}

export function composerSuggestionKey(suggestion: ComposerSuggestion): string {
  return suggestion.kind === 'picker' ? suggestion.item.id : `file:${suggestion.path}`
}

/** The text the suggestion inserts at the trigger span. */
export function composerSuggestionInsertText(suggestion: ComposerSuggestion): string {
  return suggestion.kind === 'picker' ? suggestion.item.token : `@${suggestion.path}`
}

function SuggestionRow({
  suggestion,
  onPick
}: {
  suggestion: ComposerSuggestion
  onPick: (suggestion: ComposerSuggestion) => void
}): React.JSX.Element {
  const item = suggestion.kind === 'picker' ? suggestion.item : null
  const argumentHint = item?.kind === 'command' ? item.argumentHint : undefined
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
      onPress={() => onPick(suggestion)}
    >
      <View style={styles.tokenLine}>
        <Text style={styles.suggestionText} numberOfLines={1}>
          {composerSuggestionInsertText(suggestion)}
        </Text>
        {argumentHint ? (
          <Text style={styles.argumentHint} numberOfLines={1}>
            {argumentHint}
          </Text>
        ) : null}
      </View>
      {item?.description ? (
        <Text style={styles.suggestionDescription} numberOfLines={1}>
          {item.description}
        </Text>
      ) : null}
    </Pressable>
  )
}

function renderSectionHeader({
  section
}: {
  section: SectionListData<ComposerSuggestion, ComposerSuggestionSection>
}): React.JSX.Element | null {
  return section.title ? (
    <Text accessibilityRole="header" style={styles.sectionHeading}>
      {section.title}
    </Text>
  ) : null
}

// Memoized: streamed transcript frames re-render the composer's parents while
// the menu is open, and the rows only change with the query or the catalog.
export const MobileNativeChatComposerSuggestions = memo(
  function MobileNativeChatComposerSuggestions({
    sections,
    onPick
  }: {
    sections: readonly ComposerSuggestionSection[]
    onPick: (suggestion: ComposerSuggestion) => void
  }): React.JSX.Element {
    const renderItem = useCallback<
      SectionListRenderItem<ComposerSuggestion, ComposerSuggestionSection>
    >(({ item }) => <SuggestionRow suggestion={item} onPick={onPick} />, [onPick])
    return (
      <View style={styles.suggestions}>
        <SectionList
          sections={sections}
          keyExtractor={composerSuggestionKey}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="always"
          style={styles.suggestionScroll}
        />
      </View>
    )
  }
)

const styles = StyleSheet.create({
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  suggestionScroll: {
    maxHeight: 220
  },
  sectionHeading: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6
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
  tokenLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs
  },
  suggestionText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  argumentHint: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  suggestionDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
})
