import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ScrollView, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { loadProjectsHomeEnabled, saveProjectsHomeEnabled } from '../src/storage/preferences'

export default function ExperimentalSettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [projectsHome, setProjectsHome] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadProjectsHomeEnabled().then((enabled) => {
      if (!cancelled) {
        setProjectsHome(enabled)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleProjectsHome = useCallback((enabled: boolean) => {
    setProjectsHome(enabled)
    void saveProjectsHomeEnabled(enabled)
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Experimental</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>
          Unfinished features. They can change or disappear in any release.
        </Text>

        <View style={styles.section}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Projects home</Text>
              <Text style={styles.rowSublabel}>
                Replace the list of desktops with one workspace list covering every paired desktop,
                filterable by host.
              </Text>
            </View>
            <Switch
              value={projectsHome}
              onValueChange={toggleProjectsHome}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
              accessibilityLabel="Projects home"
            />
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  intro: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 17,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowContent: {
    flex: 1,
    gap: spacing.xs
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 17
  }
})
