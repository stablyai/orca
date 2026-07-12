import { useCallback, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Linking,
  ActivityIndicator,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Bell,
  Wrench,
  Shield,
  LifeBuoy,
  Mic,
  Globe,
  Terminal as TerminalIcon,
  KeyRound
} from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'
import {
  loadPendingHostCredentialCleanupIds,
  subscribePendingHostCredentialCleanup
} from '../src/transport/host-credential-cleanup'
import { retryPendingHostCredentialCleanup } from '../src/transport/host-store'

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [pendingCredentialIds, setPendingCredentialIds] = useState<string[]>([])
  const [retryingCredentialCleanup, setRetryingCredentialCleanup] = useState(false)
  const [credentialRetryFailed, setCredentialRetryFailed] = useState(false)
  const credentialRefreshGenerationRef = useRef(0)

  useFocusEffect(
    useCallback(() => {
      let active = true
      setCredentialRetryFailed(false)
      const refresh = () => {
        const generation = ++credentialRefreshGenerationRef.current
        void loadPendingHostCredentialCleanupIds().then((ids) => {
          if (active && generation === credentialRefreshGenerationRef.current) {
            setPendingCredentialIds(ids)
            // Why: neutral copy once the queue is empty so a later pending
            // set does not inherit a previous Retry failure message.
            if (ids.length === 0) {
              setCredentialRetryFailed(false)
            }
          }
        })
      }
      const unsubscribe = subscribePendingHostCredentialCleanup(refresh)
      refresh()
      return () => {
        active = false
        credentialRefreshGenerationRef.current += 1
        unsubscribe()
      }
    }, [])
  )

  const retryCredentialCleanup = useCallback(async () => {
    if (retryingCredentialCleanup) {
      return
    }
    setCredentialRetryFailed(false)
    setRetryingCredentialCleanup(true)
    try {
      const result = await retryPendingHostCredentialCleanup()
      setPendingCredentialIds(result.remainingIds)
      setCredentialRetryFailed(result.remainingIds.length > 0)
    } catch {
      setCredentialRetryFailed(true)
    } finally {
      setRetryingCredentialCleanup(false)
    }
  }, [retryingCredentialCleanup])

  const pendingCredentialCount = pendingCredentialIds.length

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/terminal-settings')}
          >
            <TerminalIcon size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Terminal</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/browser-settings')}
          >
            <Globe size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Browser</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/voice-settings')}
          >
            <Mic size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Voice</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/notifications')}
          >
            <Bell size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Notifications</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/troubleshoot')}
          >
            <Wrench size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Troubleshooting</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push('/about')}
          >
            <Info size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>About</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>

        {pendingCredentialCount > 0 ? (
          <View style={[styles.section, styles.sectionSpacer]}>
            <View style={styles.credentialCleanupRow}>
              <KeyRound size={16} color={colors.statusAmber} />
              <View style={styles.credentialCleanupCopy}>
                <Text style={styles.credentialCleanupTitle}>Pairing credential cleanup</Text>
                <Text accessibilityLiveRegion="polite" style={styles.rowHint}>
                  {credentialRetryFailed
                    ? "Cleanup still couldn't be confirmed. Try again later."
                    : `Couldn't confirm cleanup for ${pendingCredentialCount} credential${pendingCredentialCount === 1 ? '' : 's'} on this device.`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry clearing pairing credentials"
                accessibilityState={{
                  busy: retryingCredentialCleanup,
                  disabled: retryingCredentialCleanup
                }}
                disabled={retryingCredentialCleanup}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && !retryingCredentialCleanup && styles.rowPressed
                ]}
                onPress={() => void retryCredentialCleanup()}
              >
                {retryingCredentialCleanup ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Text style={styles.retryButtonText}>Retry</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={[styles.section, styles.sectionSpacer]}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => void Linking.openURL('https://www.onorca.dev/privacy')}
          >
            <Shield size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Privacy Policy</Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => void Linking.openURL('https://github.com/stablyai/orca/issues')}
          >
            <LifeBuoy size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>Support</Text>
          </Pressable>
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
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  sectionSpacer: {
    marginTop: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  credentialCleanupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  credentialCleanupCopy: {
    flex: 1,
    gap: spacing.xs
  },
  credentialCleanupTitle: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowHint: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 17
  },
  retryButton: {
    width: 72,
    height: 32,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
