import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import {
  mobileNativeChatComposerSkillStyles as styles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'
import { MobileNativeChatComposerFieldCopy } from './MobileNativeChatComposerFieldCopy'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { composerInputStyles } from '../../../components/composer-input/composer-input-styles'

export function MobileNativeChatComposerField({
  value,
  skillToken,
  dictationPreview,
  placeholder,
  ref,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
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
