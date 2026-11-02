import { useRef, type ReactNode, type RefObject } from 'react'
import { TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useTextInputContentHeight } from '../../platform/text-input-content-height'
import { ComposerSendButton } from './ComposerSendButton'
import {
  composerInputStyles as styles,
  FORM_MESSAGE_MIN_HEIGHT,
  MESSAGE_MAX_HEIGHT,
  MESSAGE_MIN_HEIGHT
} from './composer-input-styles'
import { useInputFocus } from './use-input-focus'

type MessageBoxProps = Omit<
  TextInputProps,
  'style' | 'placeholderTextColor' | 'selectionColor' | 'value' | 'onChangeText'
> & {
  value: string
  onChangeText: (text: string) => void
  inputRef?: RefObject<TextInput | null>
  /** Shows the round Send button at the end of the action row. */
  onSend?: () => void
  canSend?: boolean
  sending?: boolean
  sendAccessibilityLabel?: string
  /** Controls at the start of the action row. */
  leading?: ReactNode
  /** Controls at the end of the action row, before Send. */
  trailing?: ReactNode
  /** Drawn over the text, which hides while it is set, e.g. dictation's live preview. */
  inputOverlay?: ReactNode
  monospace?: boolean
  /** One pill-shaped row with its controls beside the text, for short replies. */
  inline?: boolean
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
  inputOverlay,
  monospace = false,
  inline = false,
  style,
  editable = true,
  multiline = true,
  onFocus,
  onBlur,
  ...inputProps
}: MessageBoxProps): React.JSX.Element {
  useMobileColorScheme()
  const ownRef = useRef<TextInput>(null)
  const ref = inputRef ?? ownRef
  const contentHeight = useTextInputContentHeight(ref, value)
  const focus = useInputFocus({ onFocus, onBlur })
  const hasActions = leading !== undefined || trailing !== undefined || onSend !== undefined
  const minHeight = hasActions ? MESSAGE_MIN_HEIGHT : FORM_MESSAGE_MIN_HEIGHT
  return (
    <View
      style={[
        styles.box,
        // A box with its own controls is marked by them, like the chat composer; a bare one by its edge.
        !hasActions && styles.formBox,
        !hasActions && focus.focused && styles.focused,
        inline && styles.inlineBox,
        style
      ]}
    >
      {/* Always wrapped, so showing the overlay never remounts the field under the keyboard. */}
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
            monospace && styles.mono,
            contentHeight !== undefined && {
              height: Math.min(MESSAGE_MAX_HEIGHT, Math.max(minHeight, contentHeight))
            },
            !editable && styles.disabled,
            inputOverlay !== undefined && styles.hiddenText
          ]}
          {...inputProps}
          // Only a bare box draws a ring, so only it re-renders on focus.
          onFocus={hasActions ? onFocus : focus.onFocus}
          onBlur={hasActions ? onBlur : focus.onBlur}
        />
        {inputOverlay}
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
