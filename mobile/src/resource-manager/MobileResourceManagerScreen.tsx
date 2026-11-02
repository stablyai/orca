import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { themedStyleSheet } from '../theme/themed-styles'

export function MobileResourceManagerScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  const [hostName, setHostName] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts()
      .then((hosts) => {
        if (stale) {
          return
        }
        const host = hosts.find((h) => h.id === hostId)
        if (!host) {
          setError(t('resourceManager.hostNotFound', 'Host not found'))
          return
        }
        setHostName(host.name)
      })
      .catch((e) => {
        if (!stale) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [hostId, t])

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>{t('resourceManager.title', 'Resource Manager')}</Text>
          {hostName ? (
            <Text style={styles.subheading} numberOfLines={1}>
              {hostName}
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {loading ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>
              {t('resourceManager.loading', 'Loading resources…')}
            </Text>
          </View>
        ) : error ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.bodyText}>
              {t(
                'resourceManager.desktopHint',
                'Manage terminals and processes from the desktop Resource Manager.'
              )}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  titleWrap: { flex: 1 },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  subheading: { fontSize: 12, color: colors.textSecondary },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    padding: spacing.md
  },
  bodyText: { color: colors.textSecondary },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm
  },
  placeholderText: { color: colors.textSecondary },
  errorText: { color: colors.statusRed }
}))
