import { StyleSheet, type TextInput, type TextInputProps } from 'react-native'
import { colors } from '../../../theme/mobile-theme'

export type MobileNativeChatComposerFieldProps = Omit<
  TextInputProps,
  'value' | 'children' | 'onScroll' | 'style'
> & {
  value: string
  skillToken: string | null
  ref?: React.Ref<TextInput>
}

// Use the field’s exact font so the web overlay and transparent textarea occupy identical space.
export const mobileNativeChatComposerSkillStyles = StyleSheet.create({
  token: {
    color: colors.skillToken,
    backgroundColor: colors.skillTokenSurface
  }
})
