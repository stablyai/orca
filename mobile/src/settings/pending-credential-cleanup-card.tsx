import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { KeyRound } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadPendingHostCredentialCleanup,
  subscribePendingHostCredentialCleanup
} from '../transport/host-credential-cleanup'
import { retryPendingHostCredentialCleanup } from '../transport/host-store'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function PendingCredentialCleanupCard() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [pendingCredentialIds, setPendingCredentialIds] = useState<string[]>([])
  const [credentialStorageUnreadable, setCredentialStorageUnreadable] = useState(false)
  const [retryingCredentialCleanup, setRetryingCredentialCleanup] = useState(false)
  const [credentialRetryFailed, setCredentialRetryFailed] = useState(false)
  const credentialRefreshGenerationRef = useRef(0)

  useFocusEffect(
    useCallback(() => {
      let active = true
      setCredentialRetryFailed(false)
      const refresh = () => {
        const generation = ++credentialRefreshGenerationRef.current
        void loadPendingHostCredentialCleanup().then((state) => {
          if (active && generation === credentialRefreshGenerationRef.current) {
            setPendingCredentialIds(state.ids)
            setCredentialStorageUnreadable(state.storageUnreadable)
            // Clear the old retry failure when the queue empties so later entries start with neutral copy.
            if (state.ids.length === 0 && !state.storageUnreadable) {
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
      setCredentialStorageUnreadable(result.storageUnreadable)
      setCredentialRetryFailed(result.remainingIds.length > 0 || result.storageUnreadable)
    } catch {
      setCredentialRetryFailed(true)
    } finally {
      setRetryingCredentialCleanup(false)
    }
  }, [retryingCredentialCleanup])

  const count = pendingCredentialIds.length
  // Unreadable durable queues may hide orphaned tokens; keep cleanup and Retry visible.
  if (count === 0 && !credentialStorageUnreadable) {
    return null
  }

  return (
    <View style={[styles.section, styles.sectionSpacer]}>
      <View style={styles.credentialCleanupRow}>
        <KeyRound size={16} color={colors.statusAmber} />
        <View style={styles.credentialCleanupCopy}>
          <Text style={styles.credentialCleanupTitle}>
            {t('settings.pendingCredentialCleanupCard.title', 'Pairing credential cleanup')}
          </Text>
          <Text accessibilityLiveRegion="polite" style={styles.rowHint}>
            {credentialRetryFailed
              ? t(
                  'settings.pendingCredentialCleanupCard.retryFailed',
                  "Cleanup still couldn't be confirmed. Try again later."
                )
              : count > 0
                ? count === 1
                  ? t(
                      'settings.pendingCredentialCleanupCard.cleanupUnconfirmed_one',
                      "Couldn't confirm cleanup for {{count}} credential on this device.",
                      { count }
                    )
                  : t(
                      'settings.pendingCredentialCleanupCard.cleanupUnconfirmed_other',
                      "Couldn't confirm cleanup for {{count}} credentials on this device.",
                      { count }
                    )
                : t(
                    'settings.pendingCredentialCleanupCard.statusCheckFailed',
                    "Couldn't check cleanup status on this device. Retry to be safe."
                  )}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'settings.pendingCredentialCleanupCard.retryCleanup',
            'Retry clearing pairing credentials'
          )}
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
            <Text style={styles.retryButtonText}>{t('common.retry', 'Retry')}</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  sectionSpacer: {
    marginTop: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
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
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  }
}))
