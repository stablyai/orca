import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { radii, spacing, typography, type ThemeColors } from '../src/theme/mobile-theme'
import { extractPairingCodeFromUrl } from '../src/transport/pairing'
import { useTheme, useThemedStyles } from '../src/theme/theme-context'

export default function PairRedirectScreen() {
  const styles = useThemedStyles(createStyles)
  const { colors } = useTheme()
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
          <Text style={styles.errorText}>Missing pairing code</Text>
          <Pressable style={styles.primaryButton} onPress={goHome}>
            <Text style={styles.primaryButtonText}>Back to home</Text>
          </Pressable>
        </>
      ) : (
        <ActivityIndicator size="large" color={colors.textSecondary} />
      )}
    </View>
  )
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
  })
