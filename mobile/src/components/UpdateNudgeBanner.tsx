import { useEffect, useState } from 'react'
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { getMobileAppUpdateUrl } from './mobile-app-update-link'
import {
  getRecommendedVersionForPlatform,
  shouldShowUpdateNudge
} from './update-nudge-banner-state'
import {
  readUpdateNudgeDismissal,
  saveUpdateNudgeDismissedVersion,
  type UpdateNudgeDismissalPreference
} from '../storage/preferences'

// Why: soft nudge only — version skew degrades features silently, so surface a
// dismissible hint instead of escalating to the hard ProtocolBlockScreen.
export function UpdateNudgeBanner({
  recommendedVersions
}: {
  recommendedVersions: { ios?: string; android?: string }
}) {
  const [dismissal, setDismissal] = useState<UpdateNudgeDismissalPreference | null>(null)
  const recommendedVersion = getRecommendedVersionForPlatform(Platform.OS, recommendedVersions)

  useEffect(() => {
    let cancelled = false
    void readUpdateNudgeDismissal().then((preference) => {
      if (!cancelled) {
        setDismissal(preference)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const show = shouldShowUpdateNudge({
    recommendedVersion,
    installedVersion: Constants.expoConfig?.version ?? null,
    dismissedVersion: dismissal?.version ?? null,
    dismissedLoaded: dismissal?.loaded === true
  })
  if (!show || !recommendedVersion) {
    return null
  }

  const storeUrl = getMobileAppUpdateUrl(Platform.OS)
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>Update the Orca app for the best experience</Text>
      {storeUrl && (
        <Pressable
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel="Update the Orca app"
          onPress={() => void Linking.openURL(storeUrl)}
        >
          <Text style={styles.actionText}>Update</Text>
        </Pressable>
      )}
      <Pressable
        style={styles.dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss update reminder"
        hitSlop={8}
        onPress={() => {
          // Why: hide immediately; persistence is best-effort — a failed write
          // just means the nudge can reappear next launch.
          setDismissal({ version: recommendedVersion, loaded: true })
          void saveUpdateNudgeDismissedVersion(recommendedVersion).catch(() => {})
        }}
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
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  text: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13
  },
  action: {
    paddingVertical: spacing.xs
  },
  actionText: {
    color: colors.accentBlue,
    fontSize: 13,
    fontWeight: '600'
  },
  dismiss: {
    paddingVertical: spacing.xs
  }
})
