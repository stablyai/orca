import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { mobileNativeChatInputStyles as inputStyles } from './mobile-native-chat-input-styles'
import {
  mobileNativeChatComposerSkillStyles as skillStyles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'

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
  ref,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  const [scrollTop, setScrollTop] = useState(0)
  // Keep one tree so adding/removing a skill cannot remount the field and drop focus.
  return (
    <View style={styles.frame}>
      {skillToken ? (
        <View pointerEvents="none" style={styles.copyLayer}>
          <Text
            aria-hidden
            style={[inputStyles.input, styles.copy, { transform: [{ translateY: -scrollTop }] }]}
          >
            <Text style={skillStyles.token}>{skillToken}</Text>
            {value.slice(skillToken.length)}
          </Text>
        </View>
      ) : null}
      <TextInput
        ref={ref}
        value={value}
        style={skillToken ? [inputStyles.input, clearText().field] : inputStyles.input}
        onScroll={skillToken ? (event) => setScrollTop(scrollTopOf(event)) : undefined}
        {...props}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden'
  },
  copyLayer: {
    ...StyleSheet.absoluteFillObject
  },
  copy: {
    maxHeight: undefined
  }
})
