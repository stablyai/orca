import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Switch, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import {
  USAGE_PROVIDERS,
  DEFAULT_VISIBLE_USAGE_PROVIDERS,
  type UsageProviderKey
} from '../src/components/AccountUsage'
import {
  loadVisibleUsageProvidersSettled,
  setUsageProviderVisible
} from '../src/storage/preferences'

export default function AccountUsageSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Why: null until the stored set loads. Switches stay disabled while null so a
  // tap can't persist against the default base and silently drop a stored-only
  // provider (e.g. an opted-in Grok); the load resolves within a frame or two.
  const [visible, setVisible] = useState<Set<UsageProviderKey> | null>(null)

  // Why: this screen is the only writer of the visibility set, so load once on
  // mount rather than on every focus — a focus-reload could resolve mid-toggle
  // and overwrite the optimistic UI with a pre-write snapshot. The settled read
  // also waits for any in-flight toggle so a quick leave/return shows the latest.
  useEffect(() => {
    let active = true
    void loadVisibleUsageProvidersSettled().then((stored) => {
      if (active) {
        setVisible(stored)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const toggle = useCallback((id: UsageProviderKey, value: boolean) => {
    // Optimistic UI; the storage-level toggle re-reads the latest stored set and
    // changes only this provider, so it survives an unmount and never clobbers
    // one the user didn't touch. Swallow a write failure so the UI stays put.
    setVisible((prev) => {
      if (!prev) {
        return prev
      }
      const next = new Set(prev)
      if (value) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
    void setUsageProviderVisible(id, value).catch(() => {})
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
                  value={
                    visible
                      ? visible.has(descriptor.id)
                      : DEFAULT_VISIBLE_USAGE_PROVIDERS.includes(descriptor.id)
                  }
                  onValueChange={(v) => toggle(descriptor.id, v)}
                  disabled={visible === null}
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
