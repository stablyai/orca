import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { X } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import {
  checkForAndroidUpdate,
  skipAndroidUpdate,
  type AndroidUpdate
} from './android-update-check'

// Why: sideloaded APKs have no store to announce updates, so the app checks GitHub Releases itself.
export function AndroidUpdateBanner() {
  const [update, setUpdate] = useState<AndroidUpdate | null>(null)
  // Why: a dismiss bumps this so a check already in flight cannot re-show the banner.
  const dismissGeneration = useRef(0)

  useEffect(() => {
    const currentVersion = Constants.expoConfig?.version
    if (Platform.OS !== 'android' || !currentVersion) {
      return
    }
    let active = true
    const check = () => {
      const startedAt = dismissGeneration.current
      void checkForAndroidUpdate({ currentVersion }).then((next) => {
        if (active && startedAt === dismissGeneration.current) {
          setUpdate(next)
        }
      })
    }
    check()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        check()
      }
    })
    return () => {
      active = false
      subscription.remove()
    }
  }, [])

  const dismiss = useCallback(() => {
    if (update) {
      dismissGeneration.current += 1
      void skipAndroidUpdate(update.version)
      setUpdate(null)
    }
  }, [update])

  if (!update) {
    return null
  }
  return (
    <View style={styles.banner}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Download Orca Mobile ${update.version}`}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        onPress={() => void Linking.openURL(update.apkUrl).catch(() => {})}
      >
        <Text style={styles.text}>Orca Mobile {update.version} is available</Text>
        <Text style={styles.link}>Download APK</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Skip this update"
        hitSlop={spacing.sm}
        style={styles.dismiss}
        onPress={dismiss}
      >
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  action: { flex: 1 },
  pressed: { opacity: 0.7 },
  text: { color: colors.textSecondary, fontSize: typography.metaSize + 1 },
  link: { color: colors.accentBlue, fontSize: typography.metaSize + 1, fontWeight: '600' },
  dismiss: { padding: spacing.xs }
})
