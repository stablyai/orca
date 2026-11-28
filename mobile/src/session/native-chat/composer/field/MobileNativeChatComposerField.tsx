import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import {
  mobileNativeChatComposerSkillStylesSheet,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'
import { MobileNativeChatComposerFieldCopy } from './MobileNativeChatComposerFieldCopy'
import { composerInputStylesSheet } from '../../../../components/composer-input/composer-input-styles'
import { useThemedStyles } from '../../../../theme/themed-styles'

export function MobileNativeChatComposerField({
  value,
  skillToken,
  dictationPreview,
  placeholder,
  ref,
  onKeyboardSubmit: _onKeyboardSubmit,
  onWebPaste: _onWebPaste,
  ...props
}: MobileNativeChatComposerFieldProps) {
  const styles = useThemedStyles(mobileNativeChatComposerSkillStylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const [fieldHeight, setFieldHeight] = useState(0)
  // Keep one tree so a skill or dictation coming and going cannot remount the field and drop focus.
  return (
    <View
      style={frameStyles.frame}
      onLayout={(event) => setFieldHeight(event.nativeEvent.layout.height)}
    >
      {skillToken && !dictationPreview ? (
        <TextInput
          ref={ref}
          style={composerInputStyles.messageText}
          placeholder={placeholder}
          {...props}
        >
          <Text style={styles.token}>{skillToken}</Text>
          {value.slice(skillToken.length)}
        </TextInput>
      ) : (
        // Stays controlled by the draft while previewing, so typing and selection track it; only its text is hidden.
        <TextInput
          ref={ref}
          value={value}
          style={
            dictationPreview
              ? [composerInputStyles.messageText, frameStyles.hiddenText]
              : composerInputStyles.messageText
          }
          placeholder={dictationPreview ? undefined : placeholder}
          {...props}
        />
      )}
      {dictationPreview ? (
        <MobileNativeChatComposerFieldCopy
          value={value}
          skillToken={skillToken}
          dictationPreview={dictationPreview}
          fieldHeight={fieldHeight}
          scrollTop={0}
        />
      ) : null}
    </View>
  )
}

const frameStyles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden'
  },
  hiddenText: {
    color: 'transparent'
  }
})
