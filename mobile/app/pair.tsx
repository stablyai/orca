import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'
import { themedStyleSheet } from '../src/theme/themed-styles'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { extractPairingCodeFromUrl } from '../src/transport/pairing'

export default function PairRedirectScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const params = useLocalSearchParams<{ code?: string }>()
  const [missingCode, setMissingCode] = useState(false)

  const goHome = useCallback(() => {
    router.replace('/')
  }, [router])

  useEffect(() => {
    let disposed = false

    async function redirectToConfirm() {
      const codeParam = Array.isArray(params.code) ? params.code[0] : params.code
      if (codeParam) {
        router.replace({ pathname: '/pair-confirm', params: { code: codeParam } })
        return
      }

      const initialUrl = await Linking.getInitialURL().catch(() => null)
      const code = initialUrl ? extractPairingCodeFromUrl(initialUrl) : null
      if (disposed) {
        return
      }
      if (code) {
        router.replace({ pathname: '/pair-confirm', params: { code } })
        return
      }
      setMissingCode(true)
    }

    void redirectToConfirm()
    return () => {
      disposed = true
    }
  }, [params.code, router])

  return (
    <View style={styles.container}>
      {missingCode ? (
        <>
          <Text style={styles.errorText}>{t('app.pair.missingCode', 'Missing pairing code')}</Text>
          <Pressable style={styles.primaryButton} onPress={goHome}>
            <Text style={styles.primaryButtonText}>{t('app.pair.backToHome', 'Back to home')}</Text>
          </Pressable>
        </>
      ) : (
        <ActivityIndicator size="large" color={colors.textSecondary} />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginBottom: spacing.xl,
    textAlign: 'center'
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
