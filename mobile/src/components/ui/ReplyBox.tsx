import { useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps
} from 'react-native'
import { ArrowUp } from 'lucide-react-native'
import { colors, motion, radii, spacing, textStyles } from '../../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../../platform/text-input-font-size'
import { useTextInputContentHeight } from '../../platform/text-input-content-height'
import { pressTransition } from './transition-styles'

type ReplyBoxProps = {
  value: string
  onChangeText: (text: string) => void
  onSend: () => void
  placeholder: string
  /** Names the send button for screen readers, e.g. "Post comment". */
  sendAccessibilityLabel?: string
  sending?: boolean
  /** Locks the field and the button, e.g. while disconnected. */
  disabled?: boolean
  /** Locks only the text, e.g. while a commit runs; the box keeps its full look. */
  editable?: boolean
  /** Allows sending with nothing typed, e.g. an approval with an optional note. */
  allowEmpty?: boolean
  autoFocus?: boolean
  /** Lines before the field scrolls instead of growing. */
  maxLines?: number
  /** A control before the field, e.g. an attach button. */
  leading?: ReactNode
  /** Replaces the round send, e.g. a labelled compact "Commit" button. */
  trailing?: ReactNode
  /** Gives the text its own full-width line and puts `leading`/`trailing` in a row under it, as
   *  the chat composer does; for labelled buttons that would squeeze the field. */
  actionsBelow?: boolean
  returnKeyType?: TextInputProps['returnKeyType']
  testID?: string
}

const LINE = textStyles.body.lineHeight
const SEND = 32

/**
 * Where you write to someone: the composer's family at reply size. The field grows with what is
 * typed and the send sits inside it, always visible, dimmed until there is something to send.
 */
export function ReplyBox({
  value,
  onChangeText,
  onSend,
  placeholder,
  sendAccessibilityLabel = 'Send',
  sending = false,
  disabled = false,
  editable = true,
  allowEmpty = false,
  autoFocus = false,
  maxLines = 6,
  leading,
  trailing,
  actionsBelow = false,
  returnKeyType,
  testID
}: ReplyBoxProps) {
  const input = useRef<TextInput>(null)
  const [focused, setFocused] = useState(false)
  const contentHeight = useTextInputContentHeight(input, value)
  const canSend = !disabled && !sending && (allowEmpty || value.trim().length > 0)
  const maxHeight = LINE * maxLines + spacing.sm * 2

  const send = () => {
    if (!canSend) {
      return
    }
    Keyboard.dismiss()
    onSend()
  }

  return (
    <View
      style={[
        styles.box,
        actionsBelow && styles.boxStacked,
        focused && styles.focused,
        disabled && styles.disabled
      ]}
      testID={testID}
    >
      {actionsBelow ? null : leading}
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accentBlue}
        editable={!disabled && editable}
        autoFocus={autoFocus}
        multiline
        textAlignVertical="top"
        returnKeyType={returnKeyType}
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.field,
          actionsBelow ? styles.fieldStacked : styles.fieldInline,
          { maxHeight },
          contentHeight !== undefined && {
            height: Math.min(maxHeight, Math.max(LINE + 12, contentHeight))
          }
        ]}
      />
      {actionsBelow ? (
        <View style={styles.actionsRow}>
          {leading}
          <View style={styles.actionsSpacer} />
          {trailing}
        </View>
      ) : null}
      {actionsBelow
        ? null
        : (trailing ?? (
            <Pressable
              onPress={send}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={sendAccessibilityLabel}
              accessibilityState={{ disabled: !canSend, busy: sending }}
              style={styles.sendTouch}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.send,
                    canSend ? styles.sendReady : styles.sendIdle,
                    pressed && styles.sendPressed,
                    pressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <ArrowUp
                      size={17}
                      color={canSend ? colors.onPrimary : colors.textMuted}
                      strokeWidth={2.4}
                    />
                  )}
                </View>
              )}
            </Pressable>
          ))}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: radii.replyBox,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill
  },
  boxStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: spacing.sm,
    paddingTop: 10,
    paddingBottom: 8,
    paddingRight: 8
  },
  focused: { borderColor: colors.fieldBorderFocused },
  disabled: { opacity: motion.disabledOpacity },
  field: {
    ...textStyles.body,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minWidth: 0,
    minHeight: LINE + 12,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 6,
    color: colors.textPrimary
  },
  fieldInline: { flex: 1 },
  fieldStacked: { alignSelf: 'stretch' },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionsSpacer: { flex: 1 },
  // The 44 pt touch box overhangs the 32 pt circle into the box's own padding.
  sendTouch: { width: 44, height: 44, margin: -6, alignItems: 'center', justifyContent: 'center' },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: SEND / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendReady: { backgroundColor: colors.primary },
  sendIdle: { backgroundColor: colors.fill },
  sendPressed: { transform: [{ scale: motion.pressedIconScale }] }
})
