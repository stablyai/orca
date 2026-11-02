import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Pencil } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { useLargeSystemText } from '../theme/use-large-system-text'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'

const PENCIL_SIZE = 14
// The composer's own button height.
const EDITOR_ACTION_HEIGHT = 40

/** The editor that replaces a queued card's row: one action line, then the text on the card. Save
 *  sits on that line rather than under the field, as the keyboard leaves little height. */
export function MobileNativeChatQueuedMessageEditor({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  /** The card's "From <name>" line, kept above the text. */
  attribution: string | null
}): React.JSX.Element {
  const input = useRef<TextInput>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const saveDisabled = editor.saving || !editor.canSave
  const largeText = useLargeSystemText()
  const actions = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel editing queued message"
        accessibilityState={{ disabled: editor.saving }}
        disabled={editor.saving}
        style={({ pressed }) => [
          styles.cancel,
          pressed && styles.pressed,
          editor.saving && styles.disabled
        ]}
        onPress={editor.cancel}
      >
        <Text style={styles.cancelLabel}>Cancel</Text>
      </Pressable>
      {/* A 40pt target around a smaller pill, so the line stays one button tall. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save queued message"
        accessibilityState={{ disabled: saveDisabled }}
        disabled={saveDisabled}
        style={[styles.save, saveDisabled && styles.disabled]}
        onPress={() => void editor.save()}
      >
        {({ pressed }) => (
          <View style={[styles.savePill, pressed && styles.savePillPressed]}>
            <Text style={styles.saveLabel}>Save</Text>
          </View>
        )}
      </Pressable>
    </>
  )
  return (
    <View style={styles.editor} testID="queued-card-editor">
      <View style={styles.head}>
        <Pencil size={PENCIL_SIZE} color={colors.textMuted} strokeWidth={2} />
        <Text style={styles.label}>Editing message</Text>
        {largeText ? null : actions}
      </View>
      {largeText ? <View style={styles.actionsLine}>{actions}</View> : null}
      {attribution ? (
        <Text style={styles.attribution} numberOfLines={1}>
          {attribution}
        </Text>
      ) : null}
      <TextInput
        ref={input}
        accessibilityLabel="Edit queued message"
        value={editor.text}
        editable={!editor.saving}
        multiline
        selectionColor={colors.accentBlue}
        style={styles.input}
        onChangeText={editor.change}
      />
    </View>
  )
}

// The text column under the pencil, where the card's text was.
const TEXT_INDENT = PENCIL_SIZE + spacing.sm

const styles = StyleSheet.create({
  editor: {
    backgroundColor: colors.bgRaised,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingBottom: spacing.sm
  },
  head: {
    minHeight: EDITOR_ACTION_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  // Large text: Cancel and Save on a line of their own, under the heading.
  actionsLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  label: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + spacing.xs
  },
  // minHeight, not height: the action line grows with the system text size instead of clipping.
  cancel: {
    minHeight: EDITOR_ACTION_HEIGHT,
    minWidth: 56,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  cancelLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  save: {
    minHeight: EDITOR_ACTION_HEIGHT,
    justifyContent: 'center'
  },
  savePill: {
    minHeight: spacing.xl + spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  savePillPressed: {
    backgroundColor: colors.textSecondary
  },
  saveLabel: {
    color: colors.bgBase,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  attribution: {
    marginLeft: TEXT_INDENT,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + spacing.xs
  },
  // On the card itself: no fill or border, and no padding above or below the text.
  input: {
    marginLeft: TEXT_INDENT,
    padding: 0,
    paddingRight: spacing.md,
    maxHeight: 80,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: 20,
    textAlignVertical: 'top'
  },
  pressed: { backgroundColor: colors.bgPanel },
  disabled: { opacity: 0.5 }
})
