import { useCallback, useEffect, useState } from 'react'
import { Linking, Platform, StyleSheet, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import AboutScreen from '../src/settings/about-screen'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import {
  loadAutomaticUpdateCheckEnabled,
  saveAutomaticUpdateCheckEnabled
} from '../src/storage/preferences'

// Why: read version + native build identifier from expo-constants at
// runtime so the About screen never drifts out of sync with app.json.
// nativeBuildVersion is iOS buildNumber on iOS and versionCode on
// Android — different concepts, same role (monotonic native build id).
function getVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? '?.?.?'
  const build =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber
      : String(Constants.expoConfig?.android?.versionCode ?? '')
  return build ? `v${version} (${build})` : `v${version}`
}

export default function NativeAboutRoute() {
  const router = useRouter()
  // Why: null until the stored value is read. Rendering a default-on switch
  // first would flash ON for opted-out users, and a tap landing before the load
  // resolved would be silently reverted by it.
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let disposed = false
    void loadAutomaticUpdateCheckEnabled().then((enabled) => {
      if (!disposed) {
        setUpdateCheckEnabled(enabled)
      }
    })
    return () => {
      disposed = true
    }
  }, [])

  const toggleUpdateCheck = useCallback((enabled: boolean) => {
    setUpdateCheckEnabled(enabled)
    void saveAutomaticUpdateCheckEnabled(enabled)
  }, [])

  return (
    <AboutScreen
      onBack={() => router.back()}
      openExternal={(url) => Linking.openURL(url)}
      versionLabel={getVersionLabel()}
      footer={
        // Why: Android installs as a sideloaded APK with no store to announce a
        // new build, so the check only exists there — an iOS toggle would
        // control nothing (TestFlight already notifies).
        Platform.OS === 'android' &&
        updateCheckEnabled !== null && (
          <View style={styles.updateSection}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Check for updates</Text>
              <Switch
                value={updateCheckEnabled}
                onValueChange={toggleUpdateCheck}
                trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                thumbColor={colors.textPrimary}
              />
            </View>
            <Text style={styles.hint}>
              {updateCheckEnabled
                ? 'Asks GitHub once a day whether a newer APK was released.'
                : "Off — Orca won't contact GitHub, and won't tell you about new releases."}
            </Text>
          </View>
        )
      }
    />
  )
}

const styles = StyleSheet.create({
  updateSection: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    marginTop: spacing.lg,
    paddingBottom: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  hint: {
    paddingHorizontal: spacing.md + 2,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 16
  }
})
