import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { KeyRound, RefreshCw } from 'lucide-react-native'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import {
  loadPendingHostCredentialCleanup,
  subscribePendingHostCredentialCleanup
} from '../host-credentials/host-credential-cleanup'
import { retryPendingHostCredentialCleanup } from '../host-catalog/host-store'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from './settings-screen-frame'

export function PendingCredentialCleanupCard() {
  const colors = useMobileColors()
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

  const status = credentialRetryFailed
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
        )
  return (
    <SettingsSection separatorInset={LIST_LEADING_INSET}>
      <ListRow
        key="cleanup"
        title={t('settings.pendingCredentialCleanupCard.title', 'Pairing credential cleanup')}
        subtitle={status}
        subtitleLines={3}
        leading={<KeyRound size={18} color={colors.statusAmber} />}
      />
      <ListRow
        key="retry"
        title={t('common.retry', 'Retry')}
        accent
        busy={retryingCredentialCleanup}
        leading={<RefreshCw size={18} color={colors.accentBlue} />}
        accessory={
          retryingCredentialCleanup ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : undefined
        }
        accessibilityLabel={t(
          'settings.pendingCredentialCleanupCard.retryCleanup',
          'Retry clearing pairing credentials'
        )}
        onPress={() => void retryCredentialCleanup()}
      />
    </SettingsSection>
  )
}
