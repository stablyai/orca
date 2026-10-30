import type { RefObject } from 'react'
import type { TextInput, TextInputProps } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

export type MobileNativeChatComposerFieldProps = Omit<
  TextInputProps,
  'value' | 'children' | 'onScroll' | 'style'
> & {
  value: string
  skillToken: string | null
  // Dictation heard so far, shown between the draft's halves without becoming part of its value.
  dictationPreview?: { before: string; text: string; after: string } | null
  ref?: RefObject<TextInput | null>
}

// Use the field’s exact font so the web overlay and transparent textarea occupy identical space.
export const mobileNativeChatComposerSkillStyles = themedStyleSheet(() => ({
  token: {
    color: colors.skillToken,
    backgroundColor: colors.skillTokenSurface
  },
  dictationPreview: {
    color: colors.textMuted
  }
}))
