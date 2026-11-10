import { useMobileNativeChatComposerAllocation } from './MobileNativeChatComposerAllocation'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputInstance
} from 'react-native'
import { useKeyboardOcclusion } from '../../../platform/keyboard-occlusion'
import { hostOs } from '../../../platform/host-os'
import { useTextInputContentHeight } from '../../../platform/text-input-content-height'
import { useTextInputSelectionReveal } from '../../../platform/text-input-selection-reveal.web'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  composerInputStyles,
  MESSAGE_MIN_HEIGHT
} from '../../../components/composer-input/composer-input-styles'
import type { MobileNativeChatComposerFieldProps } from './mobile-native-chat-composer-field-skill'
import { MobileNativeChatComposerFieldCopy } from './MobileNativeChatComposerFieldCopy'

// Share of the space above the keyboard the field may grow into before it scrolls.
const MAX_HEIGHT_SHARE = 0.35

// Textareas cannot style tokens: hide their text under a styled copy while preserving the caret. RN types omit caretColor.
function clearText() {
  return { field: { color: 'transparent', caretColor: colors.textPrimary } }
}

function scrollTopOf(event: unknown): number {
  const target =
    typeof event === 'object' && event !== null && 'currentTarget' in event
      ? event.currentTarget
      : null
  return typeof target === 'object' &&
    target !== null &&
    'scrollTop' in target &&
    typeof target.scrollTop === 'number'
    ? target.scrollTop
    : 0
}

export function MobileNativeChatComposerField({
  value,
  skillToken,
  dictationPreview,
  placeholder,
  ref,
  onKeyboardSubmit,
  onKeyPress,
  onWebPaste,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  const allocation = useMobileNativeChatComposerAllocation()
  const [scrollTop, setScrollTop] = useState(0)
  const [fieldHeight, setFieldHeight] = useState(0)
  const ownRef = useRef<TextInputInstance>(null)
  const input = ref ?? ownRef
  useTextInputSelectionReveal(input)
  const paste = useEffectEvent((event: ClipboardEvent) => onWebPaste?.(event))
  // react-native-web forwards no paste prop; its TextInput ref is the textarea itself.
  useEffect(() => {
    const field: unknown = input.current
    if (!(field instanceof HTMLElement)) {
      return
    }
    const listener = (event: ClipboardEvent) => paste(event)
    field.addEventListener('paste', listener)
    return () => field.removeEventListener('paste', listener)
  }, [input])
  const shown = dictationPreview
    ? `${dictationPreview.before}${dictationPreview.text}${dictationPreview.after}`
    : value || placeholder || ''
  const contentHeight = useTextInputContentHeight(input, shown)
  // Reserve the placeholder's lines so the first keystroke cannot shrink the box and drop the transcript.
  const placeholderHeight = useTextInputContentHeight(input, placeholder ?? '')
  const windowHeight = useWindowDimensions().height
  const keyboardHeight = useKeyboardOcclusion()
  // RN Web already shrinks browser dimensions; shell WebViews report the keyboard separately.
  const visibleHeight = Math.min(windowHeight, window.innerHeight - keyboardHeight)
  const shareMaxHeight = Math.max(MESSAGE_MIN_HEIGHT, Math.round(visibleHeight * MAX_HEIGHT_SHARE))
  const sizing = {
    height: Math.max(contentHeight ?? 0, placeholderHeight ?? 0) || undefined,
    maxHeight: Math.min(shareMaxHeight, allocation?.fieldMaxHeight ?? shareMaxHeight)
  }
  const copied = Boolean(skillToken || dictationPreview)
  // Keep one tree so adding/removing a skill or dictation cannot remount the field and drop focus.
  return (
    <View
      style={styles.frame}
      onLayout={(event) => setFieldHeight(event.nativeEvent.layout.height)}
    >
      {copied ? (
        <MobileNativeChatComposerFieldCopy
          value={value}
          skillToken={skillToken}
          dictationPreview={dictationPreview}
          fieldHeight={fieldHeight}
          scrollTop={scrollTop}
        />
      ) : null}
      <TextInput
        ref={input}
        value={value}
        style={[composerInputStyles.messageText, sizing, copied ? clearText().field : null]}
        onScroll={skillToken ? (event) => setScrollTop(scrollTopOf(event)) : undefined}
        placeholder={dictationPreview ? undefined : placeholder}
        {...props}
        onKeyPress={(event) => {
          onKeyPress?.(event)
          const key = event.nativeEvent
          if (
            event.defaultPrevented ||
            !onKeyboardSubmit ||
            !(key instanceof KeyboardEvent) ||
            key.key !== 'Enter' ||
            key.isComposing ||
            key.keyCode === 229 ||
            key.shiftKey ||
            key.altKey ||
            !(hostOs() === 'ios' ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey)
          ) {
            return
          }
          event.preventDefault()
          if (!key.repeat) {
            onKeyboardSubmit()
          }
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden'
  }
})
