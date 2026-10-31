import { useEffect, useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter, useSegments, type ErrorBoundaryProps } from 'expo-router'
import { discardInitialLaunchIntent } from '../navigation/initial-launch-intent'
import { recordNativeRenderError } from '../diagnostics/native-render-log'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function NativeScreenRecovery({ error, retry }: ErrorBoundaryProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const route = useRef(useSegments().join('/'))

  useEffect(() => {
    recordNativeRenderError(error, route.current)
  }, [error])

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {t('components.nativeScreenRecovery.title', 'Something went wrong')}
      </Text>
      <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => void retry()}>
        <Text style={styles.retryText}>
          {t('components.nativeScreenRecovery.tryAgain', 'Try again')}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        style={styles.homeButton}
        onPress={() => {
          discardInitialLaunchIntent()
          router.replace('/')
        }}
      >
        <Text style={styles.homeText}>{t('components.nativeScreenRecovery.home', 'Home')}</Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    padding: spacing.xl,
    gap: spacing.md
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.sm
  },
  retryButton: {
    backgroundColor: colors.surfaceBright,
    borderRadius: radii.control,
    padding: spacing.md,
    alignItems: 'center'
  },
  retryText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  homeButton: { padding: spacing.md, alignItems: 'center' },
  homeText: { color: colors.textPrimary, fontSize: typography.bodySize }
}))
