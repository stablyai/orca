import { useCallback, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Switch, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import {
  USAGE_PROVIDERS,
  DEFAULT_VISIBLE_USAGE_PROVIDERS,
  type UsageProviderKey
} from '../src/components/AccountUsage'
import { loadVisibleUsageProviders, saveVisibleUsageProviders } from '../src/storage/preferences'

export default function AccountUsageSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [visible, setVisible] = useState<Set<UsageProviderKey>>(
    () => new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  )
  // Why: a fast toggle before the initial load resolves must win — otherwise
  // the delayed read would clobber it with the stored value (mirrors the
  // Settings → Terminal autocomplete toggle guard).
  const userToggledRef = useRef(false)

  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadVisibleUsageProviders().then((set) => {
        if (active && !userToggledRef.current) {
          setVisible(set)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  const toggle = useCallback((id: UsageProviderKey, value: boolean) => {
    userToggledRef.current = true
    setVisible((prev) => {
      const next = new Set(prev)
      if (value) {
        next.add(id)
      } else {
        next.delete(id)
      }
      // Swallow a storage write failure so the UI stays on the user's choice.
      void saveVisibleUsageProviders(next).catch(() => {})
      return next
    })
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Account usage</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>
          Choose which providers appear in the Account usage cards and the per-host accounts screen.
        </Text>

        <View style={styles.section}>
          {USAGE_PROVIDERS.map((descriptor, index) => (
            <View key={descriptor.id}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{descriptor.label}</Text>
                <Switch
                  value={visible.has(descriptor.id)}
                  onValueChange={(v) => toggle(descriptor.id, v)}
                  trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
                  thumbColor={colors.textPrimary}
                />
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
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
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: spacing.md
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.md + 2
  }
})
