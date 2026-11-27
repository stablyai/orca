import { useRef, type ReactNode, type RefObject } from 'react'
import {
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
  type TextInputInstance
} from 'react-native'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useTextInputContentHeight } from '../../platform/text-input/text-input-content-height'
import { ComposerSendButton } from './ComposerSendButton'
import {
  composerInputStylesSheet as stylesSheet,
  FORM_MESSAGE_MIN_HEIGHT,
  linesHeight,
  MESSAGE_MAX_HEIGHT,
  MESSAGE_MIN_HEIGHT
} from './composer-input-styles'
import { useThemedStyles } from '../../theme/themed-styles'

type MessageBoxProps = Omit<
  TextInputProps,
  'style' | 'placeholderTextColor' | 'selectionColor' | 'value' | 'onChangeText'
> & {
  value: string
  onChangeText: (text: string) => void
  inputRef?: RefObject<TextInputInstance | null>
  /** Shows the round Send button at the end of the action row. */
  onSend?: () => void
  canSend?: boolean
  sending?: boolean
  sendAccessibilityLabel?: string
  /** Controls at the start of the action row. */
  leading?: ReactNode
  /** Controls at the end of the action row, before Send. */
  trailing?: ReactNode
  monospace?: boolean
  /** One pill-shaped row with its controls beside the text, for short replies. */
  inline?: boolean
  /** How many lines a bare box opens at and grows to; 3 and 7 by default. */
  lines?: { min: number; max: number }
  style?: StyleProp<ViewStyle>
}

// Multi-line text in the chat composer's box, with its controls in a row underneath.
export function MessageBox({
  value,
  onChangeText,
  inputRef,
  onSend,
  canSend = value.trim().length > 0,
  sending,
  sendAccessibilityLabel,
  leading,
  trailing,
  monospace = false,
  inline = false,
  lines,
  style,
  editable = true,
  multiline = true,
  ...inputProps
}: MessageBoxProps): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const ownRef = useRef<TextInputInstance>(null)
  const ref = inputRef ?? ownRef
  const contentHeight = useTextInputContentHeight(ref, value)
  const hasActions = leading !== undefined || trailing !== undefined || onSend !== undefined
  const minHeight = lines
    ? linesHeight(lines.min)
    : hasActions
      ? MESSAGE_MIN_HEIGHT
      : FORM_MESSAGE_MIN_HEIGHT
  const maxHeight = lines ? linesHeight(lines.max) : MESSAGE_MAX_HEIGHT
  return (
    <View
      style={[
        styles.box,
        // A box with its own controls is the chat composer; a bare one is a grouped row, like TextField.
        !hasActions && styles.formBox,
        inline && styles.inlineBox,
        style
      ]}
    >
      <View style={inline ? styles.inlineText : undefined}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          multiline={multiline}
          textAlignVertical="top"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.accentBlue}
          style={[
            styles.messageText,
            !hasActions && styles.formText,
            lines && { minHeight, maxHeight },
            monospace && styles.mono,
            contentHeight !== undefined && {
              height: Math.min(maxHeight, Math.max(minHeight, contentHeight))
            },
            !editable && styles.disabled
          ]}
          {...inputProps}
        />
      </View>
      {hasActions ? (
        <View style={[styles.actionRow, inline && styles.inlineActions]}>
          {leading}
          <View style={styles.actionSpacer} />
          {trailing}
          {onSend ? (
            <ComposerSendButton
              onPress={onSend}
              canSend={canSend}
              sending={sending}
              label={sendAccessibilityLabel}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
