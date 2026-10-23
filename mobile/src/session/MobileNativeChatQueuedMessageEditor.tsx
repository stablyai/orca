import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, X, type LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion, spacing, textStyles } from '../theme/mobile-theme'
import { ReplyBox } from '../components/ui/ReplyBox'
import { pressTransition } from '../components/ui/transition-styles'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'

const CIRCLE = 32

/** The editor that replaces a queued card's row: the reply box, with Cancel and Save inside it, so
 *  it needs no line of its own for them. */
export function MobileNativeChatQueuedMessageEditor({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  /** The card's "From <name>" line, kept above the text. */
  attribution: string | null
}): React.JSX.Element {
  const saveDisabled = editor.saving || !editor.canSave
  return (
    <View style={styles.editor} testID="queued-card-editor">
      {attribution ? (
        <Text style={styles.attribution} numberOfLines={1}>
          {attribution}
        </Text>
      ) : null}
      <ReplyBox
        value={editor.text}
        onChangeText={editor.change}
        onSend={() => void editor.save()}
        placeholder="Edit queued message"
        disabled={editor.saving}
        autoFocus
        maxLines={4}
        trailing={
          <View style={styles.buttons}>
            <EditorButton
              icon={X}
              label="Cancel editing"
              tone="filled"
              disabled={editor.saving}
              onPress={editor.cancel}
            />
            <EditorButton
              icon={Check}
              label="Save edited message"
              tone={editor.canSave || editor.saving ? 'primary' : 'idle'}
              disabled={saveDisabled}
              busy={editor.saving}
              onPress={() => void editor.save()}
            />
          </View>
        }
      />
    </View>
  )
}

/** A 32 pt circle inside a 44 pt touch box that overhangs the reply box's padding. */
function EditorButton({
  icon: Icon,
  label,
  tone,
  disabled,
  busy,
  onPress
}: {
  icon: LucideIcon
  label: string
  tone: 'filled' | 'primary' | 'idle'
  disabled: boolean
  busy?: boolean
  onPress: () => void
}): React.JSX.Element {
  const [pressed, setPressed] = useState(false)
  const active = pressed && !disabled
  const fill =
    tone === 'primary'
      ? active
        ? colors.primaryPressed
        : colors.primary
      : active
        ? colors.fillPressed
        : colors.fill
  const iconColor =
    tone === 'primary' ? colors.onPrimary : tone === 'idle' ? colors.textMuted : colors.textPrimary
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // react-native-web maps aria-busy but not accessibilityState.busy.
      aria-busy={busy}
      disabled={disabled}
      style={styles.touch}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <View
        style={[
          styles.circle,
          { backgroundColor: fill },
          active && styles.pressed,
          active ? pressTransition.pressed : pressTransition.rest
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.onPrimary} />
        ) : (
          <Icon size={16} color={iconColor} strokeWidth={2.4} />
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  editor: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs
  },
  attribution: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingLeft: spacing.xs
  },
  buttons: {
    flexDirection: 'row',
    margin: -6
  },
  touch: {
    width: 40,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { transform: [{ scale: motion.pressedIconScale }] }
})
