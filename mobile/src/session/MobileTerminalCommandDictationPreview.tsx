import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { themedStyleSheet } from '../theme/themed-styles'
import { TailClippedText } from '../components/TailClippedText'
import {
  splitDraftForDictation,
  type MobileDictationPreview
} from '../dictation/mobile-dictation-text-insertion'

// Drawn over the command field while its own text is hidden: writing the field would end the keyboard's dictation or IME input.
export function MobileTerminalCommandDictationPreview({
  draft,
  preview
}: {
  draft: string
  preview: MobileDictationPreview
}) {
  useMobileColorScheme()
  const { before, after } = splitDraftForDictation(draft, preview.text, preview.anchor)
  return (
    <View pointerEvents="none" aria-hidden style={styles.layer}>
      <TailClippedText style={styles.text} after={after}>
        {before}
        <Text style={styles.heard}>{preview.text}</Text>
      </TailClippedText>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  layer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    paddingHorizontal: spacing.md
  },
  text: {
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    fontFamily: typography.monoFamily
  },
  heard: {
    color: colors.textMuted
  }
}))
