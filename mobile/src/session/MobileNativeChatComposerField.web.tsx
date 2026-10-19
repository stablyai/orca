import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { mobileNativeChatInputStyles as inputStyles } from './mobile-native-chat-input-styles'
import {
  mobileNativeChatComposerSkillStyles as skillStyles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'

// A textarea cannot style part of its text, so its own text goes clear and a copy laid over it
// draws the skill. The caret stays visible. Plain object: React Native's types lack `caretColor`.
const clearText = { field: { color: 'transparent', caretColor: colors.textPrimary } }

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

/** The composer's text field on the page, where a copy laid over the field draws the skill. */
export function MobileNativeChatComposerField({
  value,
  skillToken,
  ref,
  ...props
}: MobileNativeChatComposerFieldProps) {
  const [scrollTop, setScrollTop] = useState(0)
  // One tree whether or not a skill leads: swapping it would remount the field and drop focus.
  return (
    <View style={styles.frame}>
      {skillToken ? (
        // Positioned, so it paints over the field: touches pass through to the field below.
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
        style={skillToken ? [inputStyles.input, clearText.field] : inputStyles.input}
        // Only the copy reads it, and there is a copy only while a skill leads.
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
