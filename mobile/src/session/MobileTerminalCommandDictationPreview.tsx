import { StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'
import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_TEXT_SIZE
} from '../components/composer-input/composer-input-styles'
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
  preview,
  monospace
}: {
  draft: string
  preview: MobileDictationPreview
  monospace: boolean
}) {
  useMobileColorScheme()
  const { before, after } = splitDraftForDictation(draft, preview.text, preview.anchor)
  return (
    <View pointerEvents="none" aria-hidden style={styles.layer}>
      <TailClippedText style={[styles.text, monospace && styles.mono]} after={after}>
        {before}
        <Text style={styles.heard}>{preview.text}</Text>
      </TailClippedText>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Matches the composer's text inset so the preview sits where the typed draft would.
  layer: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 6,
    paddingTop: 2
  },
  text: {
    color: colors.textPrimary,
    fontSize: COMPOSER_TEXT_SIZE,
    lineHeight: COMPOSER_LINE_HEIGHT
  },
  mono: {
    fontFamily: typography.monoFamily
  },
  heard: {
    color: colors.textMuted
  }
}))
