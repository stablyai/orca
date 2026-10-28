import { Text, TextInput } from 'react-native'
import {
  mobileNativeChatComposerSkillStyles as styles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'
import { mobileNativeChatInputStyles as inputStyles } from './mobile-native-chat-input-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

export function MobileNativeChatComposerField({
  value,
  skillToken,
  ref,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  if (!skillToken) {
    return <TextInput ref={ref} value={value} style={inputStyles.input} {...props} />
  }
  return (
    <TextInput ref={ref} style={inputStyles.input} {...props}>
      <Text style={styles.token}>{skillToken}</Text>
      {value.slice(skillToken.length)}
    </TextInput>
  )
}
