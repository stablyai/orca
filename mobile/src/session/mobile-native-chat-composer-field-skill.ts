import { StyleSheet, type TextInput, type TextInputProps } from 'react-native'
import { colors } from '../theme/mobile-theme'

/** The composer's text field on both platforms: a TextInput that draws a leading skill in place. */
export type MobileNativeChatComposerFieldProps = Omit<
  TextInputProps,
  'value' | 'children' | 'onScroll' | 'style'
> & {
  value: string
  /** The skill the draft leads with, drawn highlighted in place. */
  skillToken: string | null
  ref?: React.Ref<TextInput>
}

/** The picked skill at the start of the draft. Same font as the text around it: on the page a copy
 *  over the field draws it, so the token must take the width the field gives it. */
export const mobileNativeChatComposerSkillStyles = StyleSheet.create({
  token: {
    color: colors.skillToken,
    backgroundColor: colors.skillTokenSurface
  }
})
