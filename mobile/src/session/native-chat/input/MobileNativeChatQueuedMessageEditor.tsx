import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { Check, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { mobileNativeChatInputStyles } from '../composer/mobile-native-chat-input-styles'
import type { MobileQueuedMessageInlineEditor } from '../../use-mobile-structured-queued-edit'
import { useTextInputContentHeight } from '../../../platform/text-input-content-height'

const BUTTON_SIZE = 28
const ICON_SIZE = 16
const LINE_HEIGHT = 20
const FIELD_PADDING_VERTICAL = 7
const FIELD_BORDER = 1
const FIELD_MIN_HEIGHT = LINE_HEIGHT + 2 * (FIELD_PADDING_VERTICAL + FIELD_BORDER)
const FIELD_MAX_HEIGHT = 4 * LINE_HEIGHT + 2 * (FIELD_PADDING_VERTICAL + FIELD_BORDER)
const FIELD_GAP = 6
const BUTTON_GAP = spacing.xs
// react-native-web drops hitSlop, so each button's own box is the 44pt-tall touch target.
const TOUCH_TARGET_HEIGHT = 44
const TARGET_OVERHANG = (TOUCH_TARGET_HEIGHT - FIELD_MIN_HEIGHT) / 2

export function MobileNativeChatQueuedMessageEditor({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  attribution: string | null
}): React.JSX.Element {
  useMobileColorScheme()
  const input = useRef<TextInput>(null)
  const contentHeight = useTextInputContentHeight(input, editor.text)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const saveDisabled = editor.saving || !editor.canSave
  const saveOff = !editor.canSave && !editor.saving
  return (
    <View style={styles.editor} testID="queued-card-editor">
      {attribution ? (
        <Text style={styles.attribution} numberOfLines={1}>
          {attribution}
        </Text>
      ) : null}
      <View style={styles.line}>
        <TextInput
          ref={input}
          accessibilityLabel="Edit queued message"
          value={editor.text}
          editable={!editor.saving}
          multiline
          selectionColor={colors.accentBlue}
          textAlignVertical="top"
          style={[
            mobileNativeChatInputStyles.freeInput,
            styles.field,
            contentHeight !== undefined && {
              height: Math.min(FIELD_MAX_HEIGHT, Math.max(FIELD_MIN_HEIGHT, contentHeight))
            },
            focused && !editor.saving && styles.fieldFocused,
            editor.saving && styles.disabled
          ]}
          onChangeText={editor.change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <EditorButton
          label="Cancel editing"
          disabled={editor.saving}
          targetStyle={styles.cancelTarget}
          squareStyle={[styles.buttonRaised, editor.saving && styles.disabled]}
          pressedStyle={styles.cancelPressed}
          onPress={editor.cancel}
        >
          <X size={ICON_SIZE} color={colors.textSecondary} strokeWidth={2} />
        </EditorButton>
        <EditorButton
          label="Save edited message"
          disabled={saveDisabled}
          busy={editor.saving}
          targetStyle={styles.saveTarget}
          squareStyle={saveOff ? styles.buttonRaised : styles.save}
          pressedStyle={styles.savePressed}
          onPress={() => void editor.save()}
        >
          {editor.saving ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Check
              size={ICON_SIZE}
              color={saveOff ? colors.textMuted : colors.bgBase}
              strokeWidth={2.6}
            />
          )}
        </EditorButton>
      </View>
    </View>
  )
}

function EditorButton({
  label,
  disabled,
  busy,
  targetStyle,
  squareStyle,
  pressedStyle,
  onPress,
  children
}: {
  label: string
  disabled: boolean
  busy?: boolean
  targetStyle: StyleProp<ViewStyle>
  squareStyle: StyleProp<ViewStyle>
  pressedStyle: StyleProp<ViewStyle>
  onPress: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  // Style the inner square separately because Pressable owns the larger invisible target.
  const [pressed, setPressed] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // react-native-web maps aria-busy but not accessibilityState.busy.
      aria-busy={busy}
      disabled={disabled}
      style={[styles.target, targetStyle]}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <View style={[styles.button, squareStyle, pressed && !disabled && pressedStyle]}>
        {children}
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  editor: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    gap: spacing.xs
  },
  attribution: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + spacing.xs
  },
  // Bottom-align with the last text line and keep overhanging targets inside editor padding.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: -TARGET_OVERHANG,
    marginRight: -spacing.sm
  },
  // Keep border width constant so focus cannot shift text.
  field: {
    minHeight: FIELD_MIN_HEIGHT,
    maxHeight: FIELD_MAX_HEIGHT,
    lineHeight: LINE_HEIGHT,
    paddingTop: FIELD_PADDING_VERTICAL,
    paddingBottom: FIELD_PADDING_VERTICAL,
    paddingHorizontal: 10,
    borderWidth: FIELD_BORDER,
    borderColor: colors.borderSubtle,
    marginVertical: TARGET_OVERHANG
  },
  fieldFocused: {
    borderColor: colors.accentBlue
  },
  target: {
    height: TOUCH_TARGET_HEIGHT,
    justifyContent: 'center'
  },
  cancelTarget: {
    paddingLeft: FIELD_GAP,
    paddingRight: BUTTON_GAP / 2
  },
  saveTarget: {
    paddingLeft: BUTTON_GAP / 2,
    paddingRight: spacing.sm
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radii.input,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonRaised: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  cancelPressed: {
    backgroundColor: colors.bgPanel
  },
  save: {
    backgroundColor: colors.textPrimary
  },
  savePressed: {
    backgroundColor: colors.textSecondary
  },
  disabled: { opacity: 0.5 }
}))
