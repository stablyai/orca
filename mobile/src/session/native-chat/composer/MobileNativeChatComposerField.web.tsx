import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { mobileNativeChatInputStyles as inputStyles } from './mobile-native-chat-input-styles'
import type { MobileNativeChatComposerFieldProps } from './mobile-native-chat-composer-field-skill'
import { MobileNativeChatComposerFieldCopy } from './MobileNativeChatComposerFieldCopy'

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
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  const [scrollTop, setScrollTop] = useState(0)
  const [fieldHeight, setFieldHeight] = useState(0)
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
        ref={ref}
        value={value}
        style={copied ? [inputStyles.input, clearText().field] : inputStyles.input}
        onScroll={skillToken ? (event) => setScrollTop(scrollTopOf(event)) : undefined}
        placeholder={dictationPreview ? undefined : placeholder}
        {...props}
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
